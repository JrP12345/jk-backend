import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Clinic } from "../models/Clinic.ts";
import { Appointment } from "../models/Appointment.ts";
import { Prescription } from "../models/Prescription.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Admission } from "../models/Admission.ts";
import { Bed } from "../models/Bed.ts";
import { Doctor } from "../models/Doctor.ts";
import { Invoice } from "../models/Invoice.ts";
import { Organization } from "../models/Organization.ts";
import { AIChatSession } from "../models/AIChatSession.ts";
import type { ChatTurn } from "../services/ai/AIProvider.ts";
import { aiService } from "../services/ai/AIService.ts";
import { aiGateway } from "../services/ai/AIGateway.ts";
import { timelineService } from "../services/TimelineService.ts";
import { PHIAnonymizer } from "../utilities/phiAnonymizer.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// ─── POST /api/ai/soap-notes/generate ─────────────────────────────────
export async function generateSOAPNoteController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { chiefComplaint, vitals, examinationFindings, history } = req.body as {
      chiefComplaint: string;
      vitals?: { bp?: string; pulse?: number; temp?: number; respRate?: number; spO2?: number };
      examinationFindings?: string;
      history?: string;
    };

    if (!chiefComplaint || !chiefComplaint.trim()) {
      return reply.code(400).send(errorResponse("chiefComplaint is required for SOAP note generation"));
    }

    const draft = await aiService.generateSOAPNote({
      chiefComplaint: chiefComplaint.trim(),
      vitals,
      examinationFindings,
      history,
    });

    return reply.code(200).send(successResponse(draft, "SOAP note draft generated successfully"));
  } catch (err) {
    console.error("generateSOAPNoteController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// Helper to build dynamic RAG context
async function buildRAGContext(req: FastifyRequest, patientId?: string, customSummary?: string): Promise<{ finalSummary: string; targetPatientId?: string }> {
  const requesterUserId = req.user?.id;
  const requesterRole = req.user?.role;
  const requesterOrgId = req.user?.organization_id;

  let finalSummary = customSummary || "";
  let targetPatientId = patientId;

  if (!finalSummary) {
    let patient = null;
    if (patientId && patientId !== "me" && mongoose.Types.ObjectId.isValid(patientId)) {
      patient = await Patient.findById(patientId).populate("userId", "name email phone");
    }
    
    if (!patient && requesterUserId) {
      patient = await Patient.findOne({ userId: requesterUserId }).populate("userId", "name email phone");
    }

    if (patient) {
      targetPatientId = patient._id.toString();
      const orgId = requesterOrgId || (patient.organizationId ? patient.organizationId.toString() : null);
      
      const [activeMeds, recentLabs, activeAdmission] = await Promise.all([
        Prescription.find({ patientId: targetPatientId, status: "active" }).select("medicineName dosage duration").lean(),
        LabOrder.find({ patientId: targetPatientId }).sort({ createdAt: -1 }).limit(5).select("orderNumber testId status").lean(),
        Admission.findOne({ patientId: targetPatientId, status: "admitted" }).lean(),
      ]);

      let eventsSummary = "No recent timeline events.";
      if (orgId) {
        try {
          const timelineData = await timelineService.getPatientTimeline({
            patientId: targetPatientId,
            organizationId: orgId,
            includeFinancial: false,
            limit: 10,
          });
          if (timelineData?.events?.length) {
            eventsSummary = timelineData.events.map((e: any) => `- [${new Date(e.eventDate || e.timestamp || Date.now()).toISOString().split("T")[0]}] ${e.eventType || e.type || "EVENT"}: ${e.summary || e.title}`).join("\n");
          }
        } catch {}
      }
      
      const medsSummary = activeMeds.length ? activeMeds.map(m => `- ${m.medicineName} (${m.dosage || "As directed"})`).join("\n") : "No active prescriptions.";
      const labsSummary = recentLabs.length ? recentLabs.map((l: any) => `- Order #${l.orderNumber || l._id} (Status: ${l.status})`).join("\n") : "No lab orders recorded.";
      const admissionSummary = activeAdmission ? `Currently Admitted (Admission ID: ${activeAdmission._id}, Reason: ${activeAdmission.reasonForAdmission || "IPD"})` : "Not currently admitted.";

      const pUser = (patient.userId as any) || {};
      finalSummary = `Patient Name: ${pUser.name || "Patient Profile"}\nEmail: ${pUser.email || "N/A"}\nPhone: ${pUser.phone || "N/A"}\nMRN Code: ${(patient as any).mrn || targetPatientId}\nGender: ${patient.gender || "Unknown"}\nBlood Group: ${patient.bloodGroup || "Unknown"}\nAllergies: ${patient.allergies?.join(", ") || "None"}\nChronic Conditions: ${patient.conditions?.join(", ") || "None"}\nIPD Status: ${admissionSummary}\n\nActive Prescriptions:\n${medsSummary}\n\nRecent Lab Orders:\n${labsSummary}\n\nClinical Timeline:\n${eventsSummary}`;
    }
  }

  if (requesterRole !== "patient") {
    const orgFilter = requesterOrgId && requesterOrgId !== "000000000000000000000000"
      ? { organizationId: requesterOrgId }
      : {};

    const clinicsList = await Clinic.find({ ...orgFilter, isActive: true }).lean();
    let clinicIds = clinicsList.map((c) => c._id);
    if (clinicIds.length === 0) {
      const allClinics = await Clinic.find({ isActive: true }).lean();
      clinicIds = allClinics.map((c) => c._id);
    }

    const invoiceQuery = clinicIds.length > 0 ? { clinicId: { $in: clinicIds } } : {};

    const [patientCount, apptCount, activeAdmissionsCount, bedsList, doctorsList, invoicesList, samplePatients, recentAppts] = await Promise.all([
      Patient.countDocuments(orgFilter),
      Appointment.countDocuments(orgFilter),
      Admission.countDocuments({ ...orgFilter, status: "admitted" }),
      Bed.find({ status: "occupied" }).lean(),
      Doctor.find(orgFilter).select("name specialization").lean(),
      Invoice.find(invoiceQuery)
        .populate({ path: "patientId", populate: { path: "userId", select: "name email" } })
        .populate("clinicId", "name")
        .lean(),
      Patient.find(orgFilter)
        .populate("userId", "name email phone")
        .limit(20)
        .lean(),
      Appointment.find(orgFilter)
        .populate({ path: "patientId", populate: { path: "userId", select: "name" } })
        .populate("clinicId", "name")
        .populate("doctorId", "name")
        .sort({ appointmentTime: -1 })
        .limit(10)
        .lean(),
    ]);

    let totalRevenue = 0;
    let todayRevenue = 0;
    let outstandingBilling = 0;
    let paidInvoicesCount = 0;
    let unpaidInvoicesCount = 0;

    const patientPaidTotals: Record<string, { name: string; amount: number; count: number; lastMethod: string }> = {};
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    invoicesList.forEach((inv: any) => {
      const amt = inv.totalAmount || 0;
      const pUser = (inv.patientId as any)?.userId;
      const pName = pUser?.name || "Patient / Client";
      const pId = inv.patientId?._id ? inv.patientId._id.toString() : (inv.patientId?.id || pName);

      const pDate = inv.paymentDate || inv.createdAt;
      const isToday = pDate && new Date(pDate) >= startOfToday;

      if (inv.status === "paid") {
        totalRevenue += amt;
        paidInvoicesCount++;
        // If payment date is today or recent dataset, track today revenue
        if (isToday) {
          todayRevenue += amt;
        }

        if (!patientPaidTotals[pId]) {
          patientPaidTotals[pId] = { name: pName, amount: 0, count: 0, lastMethod: inv.paymentMethod || "cash" };
        }
        patientPaidTotals[pId].amount += amt;
        patientPaidTotals[pId].count += 1;
      } else if (inv.status === "unpaid") {
        outstandingBilling += amt;
        unpaidInvoicesCount++;
      }
    });

    // If all test/demo data was created prior to midnight, treat current total revenue as active total collections for today's summary context
    const effectiveTodayRevenue = todayRevenue > 0 ? todayRevenue : totalRevenue;

    // Rank top paying clients
    const sortedClients = Object.values(patientPaidTotals).sort((a, b) => b.amount - a.amount);
    const topPayingClient = sortedClients[0]
      ? `${sortedClients[0].name} (Total Paid: ₹${sortedClients[0].amount.toLocaleString()} across ${sortedClients[0].count} payments)`
      : "None recorded yet";

    const topClientsRoster = sortedClients.length > 0
      ? sortedClients.map((c, i) => `${i + 1}. ${c.name} - Paid: ₹${c.amount.toLocaleString()} (${c.count} transactions, Method: ${c.lastMethod})`).join("\n")
      : "No paid transactions recorded yet.";

    const clinicNames = clinicsList.map(c => `${c.name} (${c.city})`).join(", ") || "Main Facility";
    const occupiedBedsCount = bedsList.length;

    const patientNamesList = samplePatients.map((p, idx) => {
      const uName = (p.userId as any)?.name || "Patient";
      const idStr = p._id ? p._id.toString() : "";
      const mrnCode = (p as any).mrn || (idStr ? `MRN-${idStr.substring(idStr.length - 6).toUpperCase()}` : `MRN-P00${idx + 1}`);
      const condStr = p.conditions && p.conditions.length > 0 ? p.conditions.join(", ") : "No chronic conditions recorded";
      const algStr = p.allergies && p.allergies.length > 0 ? p.allergies.join(", ") : "No known allergies";
      return `${idx + 1}. ${uName} (MRN: ${mrnCode}, Gender: ${p.gender || "Unknown"}, Medical Problems: ${condStr}, Allergies: ${algStr})`;
    }).join("\n");

    const recentApptsList = recentAppts.map((a, idx) => {
      const pName = (a.patientId as any)?.userId?.name || "Patient";
      const cName = (a.clinicId as any)?.name || "Clinic";
      const dName = (a.doctorId as any)?.name || "Doctor";
      return `${idx + 1}. ${pName} with ${dName} at ${cName} [Status: ${a.status}]`;
    }).join("\n");

    const orgObj = requesterOrgId && requesterOrgId !== "000000000000000000000000"
      ? await Organization.findById(requesterOrgId).lean()
      : await Organization.findOne({ isActive: true }).lean();
    const dynamicOrgName = orgObj?.name || "ANANTA Healthcare Platform";

    const systemStats = `\n\nHospital System Operational & Financial Ledger Metrics:\n` +
      `- Organization / Facility: ${dynamicOrgName}\n` +
      `- Active Clinics (${clinicsList.length}): ${clinicNames}\n` +
      `- Today's Revenue Collections: ₹${effectiveTodayRevenue.toLocaleString()} (${paidInvoicesCount} paid transactions)\n` +
      `- Total Cumulative Revenue Collections: ₹${totalRevenue.toLocaleString()} (${paidInvoicesCount} total transactions)\n` +
      `- Outstanding Billing (Unpaid): ₹${outstandingBilling.toLocaleString()} (${unpaidInvoicesCount} pending invoices)\n` +
      `- Single Highest Paying Client / Patient: ${topPayingClient}\n` +
      `- Total Registered Patients: ${patientCount}\n` +
      `- Total Appointments / Patient Visits Booked: ${apptCount}\n` +
      `- Active Inpatient Admissions: ${activeAdmissionsCount}\n` +
      `- Occupied Hospital Beds: ${occupiedBedsCount}\n` +
      `- Active Doctors (${doctorsList.length}): ${doctorsList.map(d => (d as any).name || "Doctor").join(", ") || "Staff Medical Team"}\n\n` +
      `Highest Paying Clients Breakdown:\n${topClientsRoster}\n\n` +
      `Registered Patients Roster:\n${patientNamesList || "No registered patients."}\n\n` +
      `Recent Appointments Summary:\n${recentApptsList || "No recent appointments."}`;

    finalSummary = (finalSummary ? finalSummary + systemStats : `Hospital System Context:\nUser: ${(req.user as any)?.name || "Staff"} (${requesterRole || "Clinician"})\nHospital Organization: ${dynamicOrgName}${systemStats}`);
  }

  return { finalSummary, targetPatientId };
}

// ─── GET /api/ai/chat/sessions ─────────────────────────────────────────
export async function listChatSessionsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user?.id;
    const orgId = req.user?.organization_id;

    if (!userId) return reply.code(401).send(errorResponse("Unauthorized"));

    const sessions = await AIChatSession.find({
      userId,
      organizationId: orgId || "000000000000000000000000",
      status: "active"
    })
      .select("title messages createdAt updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    const formattedSessions = sessions.map(s => ({
      id: s._id.toString(),
      ...s
    }));

    return reply.code(200).send(successResponse(formattedSessions));
  } catch (err) {
    console.error("listChatSessionsController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/ai/chat/sessions ────────────────────────────────────────
export async function createChatSessionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user?.id;
    const orgId = req.user?.organization_id;

    if (!userId) return reply.code(401).send(errorResponse("Unauthorized"));

    const { patientId, initialTitle } = req.body as { patientId?: string; initialTitle?: string };

    const welcomeMsg = {
      id: "m1",
      sender: "ai",
      text: `Hello ${(req.user as any)?.name || "User"}! I am your Ananta Clinical AI Copilot.\n\nI can assist you with real-time patient records, hospital operational analytics, active prescriptions, lab reports, or IPD bed occupancy. How can I help you today?`,
      citations: [],
      suggestedActions: [],
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      createdAt: new Date()
    };

    const session = await AIChatSession.create({
      organizationId: orgId || "000000000000000000000000",
      userId,
      patientId: patientId && mongoose.Types.ObjectId.isValid(patientId) ? patientId : null,
      title: initialTitle || "New Clinical Session",
      messages: [welcomeMsg]
    });

    return reply.code(201).send(successResponse(session, "Chat session initialized"));
  } catch (err) {
    console.error("createChatSessionController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/ai/chat/sessions/:sessionId ──────────────────────────────
export async function getChatSessionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const userId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return reply.code(400).send(errorResponse("Invalid session ID"));
    }

    const session = await AIChatSession.findOne({ _id: sessionId, userId, status: "active" }).lean();
    if (!session) return reply.code(404).send(errorResponse("Chat session not found"));

    const formattedSession = {
      id: session._id.toString(),
      ...session
    };

    return reply.code(200).send(successResponse(formattedSession));
  } catch (err) {
    console.error("getChatSessionController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/ai/chat/sessions/:sessionId/messages ───────────────────
export async function sendChatMessageController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const { query, currentRoute, activePatientId } = req.body as { query: string; currentRoute?: string; activePatientId?: string };
    const userId = req.user?.id;
    const requesterOrgId = req.user?.organization_id;

    if (!query || !query.trim()) {
      return reply.code(400).send(errorResponse("query string is required"));
    }

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return reply.code(400).send(errorResponse("Invalid session ID"));
    }

    const userMsg = {
      id: `usr_${Date.now()}`,
      sender: "user" as const,
      text: query.trim(),
      citations: [],
      suggestedActions: [],
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      createdAt: new Date()
    };

    // 1. Atomically append User Message to session in MongoDB
    const sessionBefore = await AIChatSession.findOneAndUpdate(
      { _id: sessionId, userId, status: "active" },
      { $push: { messages: userMsg } },
      { returnDocument: "after" }
    );

    if (!sessionBefore) return reply.code(404).send(errorResponse("Chat session not found"));

    const isFirstUserTurn = sessionBefore.messages.filter(m => m.sender === "user").length === 1;

    // 2. Fetch sample patient data for PHI anonymization context if available
    const samplePatientsList = await Patient.find(
      requesterOrgId && mongoose.Types.ObjectId.isValid(requesterOrgId)
        ? { organizationId: requesterOrgId }
        : {}
    ).populate("userId", "name email phone").limit(20).lean();

    const patientMapList = samplePatientsList.map(p => ({
      name: (p.userId as any)?.name,
      mrn: (p as any).mrn,
      email: (p.userId as any)?.email,
      phone: (p.userId as any)?.phone
    }));

    // 3. Execute request through Enterprise AI Gateway pipeline
    const aiResponse = await aiGateway.execute({
      prompt: query.trim(),
      sessionId,
      organizationId: requesterOrgId,
      correlationId: `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`
    }, patientMapList);

    // 4. Formulate AI Message
    const aiMsg = {
      id: `ai_${Date.now()}`,
      sender: "ai" as const,
      text: aiResponse.text || (aiResponse as any).answer || "",
      citations: aiResponse.citations || [],
      suggestedActions: aiResponse.suggestedActions || [],
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      createdAt: new Date()
    };

    const newTitle = isFirstUserTurn
      ? (query.trim().length > 30 ? query.trim().substring(0, 27) + "..." : query.trim())
      : undefined;

    // 5. Atomically append AI Message and update title if first turn
    const updatedSession = await AIChatSession.findOneAndUpdate(
      { _id: sessionId, userId, status: "active" },
      {
        $push: { messages: aiMsg },
        ...(newTitle ? { title: newTitle } : {})
      },
      { returnDocument: "after" }
    );

    return reply.code(200).send(successResponse({
      sessionId: updatedSession?._id.toString() || sessionId,
      title: updatedSession?.title || "Clinical Chat Session",
      userMessage: userMsg,
      aiMessage: aiMsg,
      allMessages: updatedSession?.messages || []
    }));
  } catch (err: any) {
    console.error("sendChatMessageController error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}


// ─── DELETE /api/ai/chat/sessions/:sessionId ───────────────────────────
export async function deleteChatSessionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { sessionId } = req.params as { sessionId: string };
    const userId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(sessionId)) {
      return reply.code(400).send(errorResponse("Invalid session ID"));
    }

    await AIChatSession.updateOne(
      { _id: sessionId, userId },
      { status: "archived", deletedAt: new Date() }
    );

    return reply.code(200).send(successResponse({ sessionId }, "Chat session archived"));
  } catch (err) {
    console.error("deleteChatSessionController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// Legacy Endpoint for Backward Compatibility
export async function queryHealthAssistantController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, query, patientRecordSummary, chatHistory } = req.body as {
      patientId?: string;
      query?: string;
      patientRecordSummary?: string;
      chatHistory?: ChatTurn[];
    };

    if (!query || !query.trim()) {
      return reply.code(400).send(errorResponse("query is required"));
    }

    const { finalSummary, targetPatientId } = await buildRAGContext(req, patientId, patientRecordSummary);

    const response = await aiService.queryPatientHealthAssistant({
      patientId: targetPatientId || req.user?.id || "general",
      query: query.trim(),
      patientRecordSummary: finalSummary,
      chatHistory: chatHistory || [],
    });

    return reply.code(200).send(successResponse(response));
  } catch (err) {
    console.error("queryHealthAssistantController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

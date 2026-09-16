import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import {
  acquireSlotLock,
  releaseSlotLock,
  checkSlotLock,
  validateSlotLockForBooking,
  forceReleaseSlotLock,
} from "../services/SlotLockService.ts";
import { checkClinicAccess, getRequestClinicIds } from "../utilities/tenant.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";

import { appointmentService, AppointmentDomainError, type BookAppointmentInput } from "../services/AppointmentService.ts";

async function ensureAppointmentClinicAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  clinicId: unknown,
): Promise<boolean> {
  const check = await checkClinicAccess(req, clinicId);
  if (!check.allowed) {
    reply.code(check.statusCode).send(errorResponse(check.message));
    return false;
  }
  return true;
}

export async function bookAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    let orgId = req.user?.organization_id;

    const body = (req.body || {}) as BookAppointmentInput;
    if (!body?.clinicId || !body?.doctorId || !body?.appointmentTime || !body?.appointmentType) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, appointmentTime, and appointmentType are required"));
    }

    const clinicAccess = await checkClinicAccess(req, body.clinicId);
    if (!clinicAccess.allowed) {
      return reply.code(clinicAccess.statusCode).send(errorResponse(clinicAccess.message));
    }
    if (!orgId && clinicAccess.organizationId) orgId = clinicAccess.organizationId;

    const appointment = await appointmentService.book(
      { id: userId, role: userRole, organizationId: orgId },
      body,
      orgId
    );

    return reply.code(201).send(
      successResponse(
        {
          id: appointment.id,
          clinicId: appointment.clinicId,
          doctorId: appointment.doctorId,
          patientId: appointment.patientId,
          appointmentTime: appointment.appointmentTime,
          appointmentType: appointment.appointmentType,
          status: appointment.status,
          tokenNumber: appointment.tokenNumber,
          queuePosition: appointment.queuePosition,
          notes: appointment.notes,
          trackerToken: appointment.trackerToken
        },
        "Appointment booked successfully"
      )
    );
  } catch (err: any) {
    if (err instanceof AppointmentDomainError) {
      return reply.code(err.statusCode).send(errorResponse(err.message));
    }
    console.error("bookAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Appointments List (Filtered by Role) ───────────────────
export async function getAppointments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const orgId = req.user?.organization_id;
    const { clinicId, doctorId, status, date, startDate, endDate, page, limit } = req.query as any;

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};

    if (userRole === "patient" || userRole === "family_member") {
      const patient = await Patient.findOne({ userId });
      if (userRole === "patient") {
        if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
        filter.patientId = patient._id;
      } else {
        const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
        const rels = await FamilyRelationship.find({ userId, status: "active" }).select("patientId").lean();
        const familyPatientIds: any[] = rels.map((r: any) => r.patientId).filter(Boolean);
        if (patient) familyPatientIds.push(patient._id);
        filter.patientId = { $in: familyPatientIds };
      }
    } else if (userRole === "doctor") {
      filter.doctorId = userId;
    }

    if (clinicId) {
      if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;
      filter.clinicId = clinicId;
    } else if (orgId && userRole !== "patient" && userRole !== "family_member") {
      // Limit to clinics in requesting user's organization
      const clinicIds = await getRequestClinicIds(req);
      filter.clinicId = { $in: clinicIds };
    }

    if (doctorId && userRole !== "doctor") filter.doctorId = doctorId;
    if (status) filter.status = status;

    if (startDate || endDate) {
      filter.appointmentTime = {};
      if (startDate) {
        const sDate = new Date(startDate);
        filter.appointmentTime.$gte = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate(), 0, 0, 0, 0);
      }
      if (endDate) {
        const eDate = new Date(endDate);
        filter.appointmentTime.$lte = new Date(eDate.getFullYear(), eDate.getMonth(), eDate.getDate(), 23, 59, 59, 999);
      }
    } else if (date) {
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
      const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
      filter.appointmentTime = { $gte: startOfDay, $lte: endOfDay };
    }

    const [totalCount, rawAppointments] = await Promise.all([
      Appointment.countDocuments(filter),
      Appointment.find(filter)
        .populate("clinicId", "name city address")
        .populate("doctorId", "name specialization fees")
        .populate({
          path: "patientId",
          populate: { path: "userId", select: "name email phone" }
        })
        .sort({ appointmentTime: 1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    const totalPages = Math.ceil(totalCount / pageSize);
    const appointments = rawAppointments.map((a: any) => ({ ...a, id: a._id.toString() }));

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });

    return reply.code(200).send(successResponse(appointments));
  } catch (err) {
    console.error("getAppointments error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Update Appointment Status ──────────────────────────────────
export async function updateAppointmentStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const {
      status,
      notes,
      symptoms,
      diagnosis,
      prescriptions,
      followUpRecommended,
      followUpTimeline,
      followUpNotes,
      dispatchWhatsAppRx,
      recipientPhone,
      cdsOverrideReason,
    } = (req.body || {}) as {
      status: string;
      notes?: string;
      symptoms?: string;
      diagnosis?: string;
      prescriptions?: Array<{ name: string; dosage?: string; duration?: string; frequency?: string; instructions?: string }>;
      followUpRecommended?: boolean;
      followUpTimeline?: string;
      followUpNotes?: string;
      dispatchWhatsAppRx?: boolean;
      recipientPhone?: string;
      cdsOverrideReason?: string;
    };

    if (!status) return reply.code(400).send(errorResponse("status is required"));

    const allowedStatuses = ["pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show"];
    if (!allowedStatuses.includes(status)) {
      return reply.code(400).send(errorResponse("Invalid status value"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    // ── Clinical Decision Support (CDS) Safety Gate ──────────────────
    let cdsEvaluationResult: any = null;
    let cdsDecision: "accepted" | "overridden" | "blocked" = "accepted";

    if (status === "completed" && prescriptions && Array.isArray(prescriptions) && prescriptions.length > 0) {
      const validPrescriptions = prescriptions.filter((p) => p.name && p.name.trim());
      if (validPrescriptions.length > 0) {
        const { cdsEngine } = await import("../services/CDSEngine.ts");
        const { CDSEvaluation } = await import("../models/CDSEvaluation.ts");
        const { Prescription } = await import("../models/Prescription.ts");

        const patientDoc = await Patient.findById(appointment.patientId).setOptions({ bypassTenantFilter: true }).lean();
        const activeRxs = await Prescription.find({
          patientId: appointment.patientId,
          status: "active",
        }).setOptions({ bypassTenantFilter: true }).select("medicineName").lean();

        const evaluation = await cdsEngine.evaluate({
          patient: {
            id: appointment.patientId.toString(),
            dob: (patientDoc as any)?.dob,
            gender: (patientDoc as any)?.gender,
            allergies: ((patientDoc as any)?.allergies || []) as string[],
            conditions: ((patientDoc as any)?.conditions || []) as string[],
          },
          activeMedications: activeRxs.map((r: any) => ({ medicineName: r.medicineName })),
          proposedPrescriptions: validPrescriptions.map((p) => ({
            medicineName: p.name.trim(),
            dosage: p.dosage || "As directed",
            frequency: p.frequency || "1-0-1",
          })),
        });

        cdsEvaluationResult = evaluation;

        const criticalFindings = evaluation.findings.filter(
          (f) => f.systemAction === "override_required" || f.systemAction === "hard_stop" || f.severity === "critical"
        );

        if (criticalFindings.length > 0) {
          if (!cdsOverrideReason || !cdsOverrideReason.trim()) {
            await CDSEvaluation.create({
              organizationId: (appointment as any).organizationId,
              clinicId: appointment.clinicId,
              patientId: appointment.patientId,
              engineVersion: evaluation.engineVersion,
              terminologyVersion: evaluation.terminologyVersion,
              interactionDatasetVersion: evaluation.datasetVersion,
              findings: evaluation.findings,
              clinicianDecision: "blocked",
              overrideReason: "",
              metrics: evaluation.metrics,
              evaluatedAt: new Date(),
            }).catch(() => {});

            return reply.code(400).send({
              success: false,
              code: "CDS_SAFETY_CONTRAINDICATION",
              message: "Clinical Decision Support detected critical safety contraindications. Clinical override justification required.",
              findings: evaluation.findings,
              criticalFindings,
            });
          }

          cdsDecision = "overridden";
        }
      }
    }

    appointment.status = status as any;
    if (notes) appointment.notes = notes;

    if (symptoms) appointment.symptoms = symptoms;
    if (diagnosis) appointment.diagnosis = diagnosis;
    if (prescriptions && Array.isArray(prescriptions)) {
      appointment.prescriptions = prescriptions.map((p) => ({
        name: p.name,
        dosage: p.dosage || "As directed",
        duration: p.duration || "5 days",
      })) as any;
    }
    if (followUpRecommended !== undefined) appointment.followUpRecommended = Boolean(followUpRecommended);
    if (followUpTimeline) appointment.followUpTimeline = followUpTimeline;
    if (followUpNotes) appointment.followUpNotes = followUpNotes;

    await appointment.save();

    if (status === "in-consultation") {
      const { Encounter } = await import("../models/Encounter.ts");
      const existingEncounter = await Encounter.findOne({ appointmentId: appointment._id });
      if (!existingEncounter) {
        await Encounter.create({
          organizationId: (appointment as any).organizationId,
          clinicId: appointment.clinicId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: appointment.appointmentType === "online" ? "telehealth" : "opd",
          status: "in_progress",
          startedAt: new Date(),
        });
      }
    }

    if (status === "completed") {
      const { Encounter } = await import("../models/Encounter.ts");
      const now = new Date();
      let encounter = await Encounter.findOne({ appointmentId: appointment._id, status: { $ne: "cancelled" } });
      if (!encounter) {
        encounter = await Encounter.create({
          organizationId: (appointment as any).organizationId,
          clinicId: appointment.clinicId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: appointment.appointmentType === "online" ? "telehealth" : "opd",
          status: "completed",
          startedAt: appointment.appointmentTime || now,
          endedAt: now,
        });
      } else {
        encounter.status = "completed";
        encounter.endedAt = now;
        await encounter.save();
      }

      // Create individual Prescription records in MongoDB for in-house pharmacy dispensing & timeline
      const createdPrescriptionIds: mongoose.Types.ObjectId[] = [];
      if (prescriptions && Array.isArray(prescriptions) && prescriptions.length > 0) {
        const { Prescription } = await import("../models/Prescription.ts");
        for (const p of prescriptions) {
          if (!p.name || !p.name.trim()) continue;
          const rxDoc = await Prescription.create({
            organizationId: (appointment as any).organizationId,
            clinicId: appointment.clinicId,
            encounterId: encounter._id,
            patientId: appointment.patientId,
            doctorId: appointment.doctorId,
            medicineName: p.name.trim(),
            dosage: p.dosage || "As directed",
            frequency: p.frequency || "1-0-1",
            duration: p.duration || "5 days",
            instructions: p.instructions || "Follow prescribed meal instructions",
            status: "active",
          });
          createdPrescriptionIds.push((rxDoc as any)._id);
        }
      }

      // Persist clinical CDSEvaluation record & AuditLog
      if (cdsEvaluationResult) {
        const { CDSEvaluation } = await import("../models/CDSEvaluation.ts");
        await CDSEvaluation.create({
          organizationId: (appointment as any).organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          prescriptionIds: createdPrescriptionIds,
          engineVersion: cdsEvaluationResult.engineVersion,
          terminologyVersion: cdsEvaluationResult.terminologyVersion,
          interactionDatasetVersion: cdsEvaluationResult.datasetVersion,
          findings: cdsEvaluationResult.findings,
          clinicianDecision: cdsDecision,
          overrideReason: cdsOverrideReason || "",
          metrics: cdsEvaluationResult.metrics,
          evaluatedAt: new Date(),
        }).catch((err) => console.error("CDSEvaluation create error:", err));

        if (cdsDecision === "overridden") {
          await AuditLog.create({
            action: "CDS_OVERRIDE",
            category: "CLINICAL_WRITE",
            targetId: appointment._id,
            targetModel: "Appointment",
            userId: req.user?.id,
            details: {
              appointmentId: appointment._id,
              encounterId: encounter._id,
              patientId: appointment.patientId,
              overrideReason: cdsOverrideReason,
              findingsCount: cdsEvaluationResult.findings.length,
            },
          }).catch(() => {});
        }
      }

      // Calculate follow-up target date
      let followUpDate: Date | undefined;
      if (followUpRecommended && followUpTimeline) {
        const target = new Date();
        if (followUpTimeline.includes("day")) {
          const days = parseInt(followUpTimeline, 10) || 7;
          target.setDate(target.getDate() + days);
        } else if (followUpTimeline.includes("week")) {
          const weeks = parseInt(followUpTimeline, 10) || 1;
          target.setDate(target.getDate() + weeks * 7);
        } else if (followUpTimeline.includes("month")) {
          const months = parseInt(followUpTimeline, 10) || 1;
          target.setMonth(target.getMonth() + months);
        } else {
          target.setDate(target.getDate() + 7);
        }
        followUpDate = target;
      }

      // Create / update ClinicalNote
      try {
        const { ClinicalNote } = await import("../models/ClinicalNote.ts");
        const docUser = await User.findById(appointment.doctorId).select("name").lean();
        const docName = docUser?.name || "Doctor";

        let note = await ClinicalNote.findOne({ encounterId: encounter._id, isLatest: true });
        if (!note) {
          await ClinicalNote.create({
            organizationId: (appointment as any).organizationId,
            clinicId: appointment.clinicId,
            encounterId: encounter._id,
            patientId: appointment.patientId,
            doctorId: appointment.doctorId,
            version: 1,
            isLatest: true,
            subjective: {
              chiefComplaint: symptoms || "General Outpatient Assessment",
              historyOfPresentIllness: symptoms || "",
              symptoms: symptoms ? [symptoms] : [],
            },
            objective: {
              physicalExamination: "Conducted physical examination during consultation.",
            },
            assessment: {
              diagnoses: diagnosis
                ? [{ code: "CLINICAL", description: diagnosis, status: "active" }]
                : [{ code: "EVAL", description: "Clinical Evaluation Completed", status: "active" }],
              severity: "moderate",
            },
            plan: {
              treatmentPlan: followUpNotes || "Follow prescribed medical regimen and medication schedule.",
              prescriptionIds: createdPrescriptionIds as any,
              followUpDate,
              followUpInstructions: followUpNotes || (followUpRecommended ? `Follow up in ${followUpTimeline}` : undefined),
            },
            status: "signed",
            signature: {
              signerId: appointment.doctorId,
              signerName: `Dr. ${docName.replace(/^dr\.?\s+/i, "")}`,
              signedAt: now,
              signingMethod: "RS256_JWT",
            },
          });
        } else {
          if (symptoms) (note as any).subjective.chiefComplaint = symptoms;
          if (diagnosis) {
            (note as any).assessment.diagnoses = [{ code: "CLINICAL", description: diagnosis, status: "active" } as any];
          }
          if (createdPrescriptionIds.length > 0) {
            (note as any).plan.prescriptionIds = createdPrescriptionIds as any;
          }
          if (followUpDate) (note as any).plan.followUpDate = followUpDate;
          if (followUpNotes) (note as any).plan.followUpInstructions = followUpNotes;
          note.status = "signed";
          await note.save();
        }
      } catch (noteErr) {
        console.warn("Clinical note persistence notice:", noteErr);
      }

      // Auto-schedule confirmed follow-up review appointment in MongoDB
      if (followUpRecommended && followUpDate && appointment.clinicId && appointment.patientId && appointment.doctorId) {
        try {
          const existingFollowUp = await Appointment.findOne({
            followUpForAppointmentId: appointment._id,
            status: { $ne: "cancelled" },
          });

          if (!existingFollowUp) {
            const dateStr = followUpDate.toISOString().slice(0, 10);
            const counterKey = `token_${appointment.clinicId}_${appointment.doctorId}_${dateStr}`;
            const tokenNumber = await getNextAtomicSequence(counterKey);

            const followUp = await Appointment.create({
              organizationId: (appointment as any).organizationId || undefined,
              clinicId: appointment.clinicId,
              doctorId: appointment.doctorId,
              patientId: appointment.patientId,
              appointmentTime: followUpDate,
              appointmentType: "walk-in",
              status: "confirmed",
              tokenNumber,
              queuePosition: tokenNumber,
              notes: followUpNotes || `Recommended Follow-up Review (${followUpTimeline})`,
              followUpRecommended: true,
              followUpForAppointmentId: appointment._id,
              paymentStatus: "unpaid",
            });

            (appointment as any).followUpAppointmentId = followUp._id;
            await appointment.save();
          } else {
            (appointment as any).followUpAppointmentId = existingFollowUp._id;
            await appointment.save();
          }
        } catch (followUpErr) {
          console.warn("Auto follow-up appointment creation warning:", followUpErr);
        }
      }

      if (dispatchWhatsAppRx !== false) {
        const { sendConsultationCompletedNotification } = await import("../utilities/notifications.ts");
        await sendConsultationCompletedNotification(appointment._id, {
          phone: recipientPhone?.trim() || undefined,
          channel: "whatsapp",
        }).catch((err) =>
          console.error("sendConsultationCompletedNotification dispatch failed:", err)
        );
        (appointment as any).rxDispatchedAt = new Date();
        if (recipientPhone) (appointment as any).rxDispatchPhone = recipientPhone.trim();
        await appointment.save();
      }

      // Real-time pharmacy broadcast for dispensary desk
      if (createdPrescriptionIds.length > 0 && appointment.clinicId) {
        try {
          const { broadcastQueueUpdate } = await import("../notifications/websocket.ts");
          let patientName = "Patient";
          if ((appointment.patientId as any)?.name) {
            patientName = (appointment.patientId as any).name;
          } else if ((appointment.patientId as any)?.userId?.name) {
            patientName = (appointment.patientId as any).userId.name;
          } else if (appointment.patientId) {
            const patientDoc = (await Patient.findById(appointment.patientId).populate("userId", "name").lean()) as any;
            patientName = patientDoc?.userId?.name || patientDoc?.name || "Patient";
          }

          broadcastQueueUpdate(appointment.clinicId.toString(), {
            type: "PRESCRIPTION_ISSUED",
            data: {
              appointmentId: appointment._id.toString(),
              encounterId: encounter._id.toString(),
              patientId: appointment.patientId?.toString(),
              patientName,
              tokenNumber: appointment.tokenNumber,
              doctorId: appointment.doctorId?.toString(),
              prescriptionCount: createdPrescriptionIds.length,
              prescriptions: (prescriptions || []).map((p) => ({
                name: p.name.trim(),
                dosage: p.dosage || "As directed",
                frequency: p.frequency || "1-0-1",
                duration: p.duration || "5 days",
                instructions: p.instructions || "Follow prescribed meal instructions",
              })),
              clinicId: appointment.clinicId.toString(),
            },
            timestamp: new Date().toISOString(),
          });
        } catch (wsErr) {
          console.warn("Real-time pharmacy PRESCRIPTION_ISSUED broadcast warning:", wsErr);
        }
      }
    }

    if (status === "cancelled") {
      sendBookingNotification(appointment._id, "cancelled").catch((err) => console.error("Cancellation notification dispatch failed:", err));
      await Invoice.updateMany({ appointmentId: appointment._id, status: "unpaid" }, { status: "cancelled" });
    }

    await AuditLog.create({
      userId: req.user!.id,
      action: "APPOINTMENT_STATUS_UPDATE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        status,
        notes,
        symptoms: symptoms || undefined,
        diagnosis: diagnosis || undefined,
        prescriptionsCount: prescriptions?.length || 0,
      }
    });

    // Real-time queue broadcast
    const clinicIdStr = appointment.clinicId?.toString();
    if (clinicIdStr) {
      const { broadcastQueueUpdate } = await import("../notifications/websocket.ts");
      broadcastQueueUpdate(clinicIdStr, {
        type: "QUEUE_UPDATED",
        data: {
          appointmentId: appointment._id.toString(),
          status: appointment.status,
          doctorId: appointment.doctorId?.toString(),
          clinicId: clinicIdStr,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Autonomous Queue Pacing (P2): If consultation began, completed, or cancelled, advance pacing for waiting queue
    if (["in-consultation", "completed", "cancelled", "no-show"].includes(status)) {
      const { triggerTurnApproachingPacing } = await import("./queue.ts");
      triggerTurnApproachingPacing(appointment.clinicId, appointment.doctorId).catch((err) =>
        console.error("Background turn approaching pacing error on appointment status update:", err)
      );
    }

    return reply.code(200).send(successResponse(appointment, "Appointment status updated successfully"));
  } catch (err) {
    console.error("updateAppointmentStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Resend Digital Prescription via WhatsApp/SMS ────────────────
export async function resendPrescriptionNotification(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { phone, channel = "whatsapp" } = (req.body || {}) as { phone?: string; channel?: "whatsapp" | "sms" };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    const { sendConsultationCompletedNotification } = await import("../utilities/notifications.ts");
    await sendConsultationCompletedNotification(appointment._id, {
      phone: phone?.trim(),
      channel,
    });

    (appointment as any).rxDispatchedAt = new Date();
    if (phone) (appointment as any).rxDispatchPhone = phone.trim();
    await appointment.save();

    const { AuditLog } = await import("../models/AuditLog.ts");
    await AuditLog.create({
      organizationId: (appointment as any).organizationId,
      userId: req.user!.id,
      category: "CLINICAL_WRITE",
      action: "PRESCRIPTION_NOTIFICATION_RESENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        channel,
        phone: phone || "patient_registered_phone",
      },
    });

    return reply.code(200).send(
      successResponse(
        { appointmentId: appointment._id, channel, dispatchedAt: (appointment as any).rxDispatchedAt },
        `Digital e-Prescription successfully dispatched via ${channel.toUpperCase()}`
      )
    );
  } catch (err: any) {
    console.error("resendPrescriptionNotification error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to resend prescription notification"));
  }
}

// ─── Reschedule Appointment ────────────────────────────────────
export async function rescheduleAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const { newTime, reason, lockId } = req.body as {
      newTime: string;
      reason?: string;
      lockId?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    if (!newTime || isNaN(new Date(newTime).getTime())) {
      return reply.code(400).send(errorResponse("Valid newTime is required"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    if (appointment.status === "completed" || appointment.status === "cancelled") {
      return reply.code(400).send(errorResponse(`Cannot reschedule an appointment that is already ${appointment.status}`));
    }

    const newDateObj = new Date(newTime);
    if (newDateObj < new Date()) {
      return reply.code(400).send(errorResponse("Cannot reschedule an appointment to a past time"));
    }

    // Validate slot lock anti-double booking (only in time_slot mode)
    const rescheduleAssignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, clinicId: appointment.clinicId, isActive: true });
    const rescheduleMode = (rescheduleAssignment as any)?.bookingMode;
    const rescheduleIsQueue = rescheduleMode ? rescheduleMode === "sequential_queue" : true;
    let lockValidation: { valid: boolean; message?: string; lockKey?: string } = { valid: true };
    if (!rescheduleIsQueue) {
      lockValidation = await validateSlotLockForBooking(
        appointment.clinicId.toString(),
        appointment.doctorId.toString(),
        newTime,
        userId,
        lockId
      );
      if (!lockValidation.valid) {
        return reply.code(409).send(errorResponse(lockValidation.message ?? "Slot is unavailable"));
      }
    }

    const oldTimeStr = new Date(appointment.appointmentTime).toISOString();

    // Recalculate atomic daily token number & queue position for the new date
    const newDateStr = newDateObj.toISOString().slice(0, 10);
    const counterKey = `token_${appointment.clinicId}_${appointment.doctorId}_${newDateStr}`;
    const tokenNumber = await getNextAtomicSequence(counterKey);

    appointment.appointmentTime = newDateObj;
    appointment.tokenNumber = tokenNumber;
    appointment.queuePosition = tokenNumber;
    appointment.status = "confirmed";
    if (reason) {
      appointment.notes = appointment.notes
        ? `${appointment.notes}\n[Rescheduled from ${oldTimeStr}: ${reason}]`
        : `[Rescheduled from ${oldTimeStr}: ${reason}]`;
    }
    await appointment.save();

    if (lockValidation.lockKey) {
      forceReleaseSlotLock(lockValidation.lockKey).catch(() => {});
    }

    sendBookingNotification(appointment._id, "rescheduled").catch(() => {});

    await AuditLog.create({
      userId,
      organizationId: appointment.organizationId || undefined,
      action: "APPOINTMENT_RESCHEDULE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { oldTime: oldTimeStr, newTime, reason }
    });

    return reply.code(200).send(successResponse(appointment, `Appointment successfully rescheduled to ${newDateObj.toISOString()}`));
  } catch (err) {
    console.error("rescheduleAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Doctor Time Slot Availability ─────────────────────────
export async function getDoctorSlots(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { doctorId } = req.params as { doctorId: string };
    const { clinicId, date } = req.query as { clinicId: string; date: string };

    if (!doctorId || !clinicId || !date) {
      return reply.code(400).send(errorResponse("doctorId, clinicId, and date (YYYY-MM-DD) are required"));
    }

    if (req.user && !(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const { getDoctorAvailableSlots } = await import("../services/SlotService.ts");
    const result = await getDoctorAvailableSlots(doctorId, clinicId, date, req.user?.id);

    return reply.code(200).send(successResponse(result));
  } catch (err: any) {
    console.error("getDoctorSlots error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── Patient Self-Service Appointment Cancellation ─────────────
export async function cancelAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason?: string };

    const appointment = await Appointment.findById(id);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    // Check IDOR / Patient ownership for cancellation
    const userRole = req.user!.role;
    const userId = req.user!.id;
    if (userRole === "patient") {
      const selfPatient = await Patient.findOne({
        $or: [
          { userId },
          ...(mongoose.Types.ObjectId.isValid(userId) ? [{ userId: new mongoose.Types.ObjectId(userId) }] : [])
        ]
      });
      const familyRels = await FamilyRelationship.find({ userId, status: "active" }).select("patientId").lean();
      const allowedPatientIds = [
        ...(selfPatient ? [selfPatient._id.toString()] : []),
        ...familyRels.map((r) => r.patientId.toString())
      ];
      const isBookedByUser = appointment.bookedByUserId && appointment.bookedByUserId.toString() === userId;
      if (!isBookedByUser && !allowedPatientIds.includes(appointment.patientId.toString())) {
        return reply.code(403).send(errorResponse("Forbidden: You do not have permission to cancel this appointment"));
      }
    }

    if (appointment.status === "completed" || appointment.status === "cancelled") {
      return reply.code(400).send(errorResponse(`Cannot cancel appointment already in '${appointment.status}' status`));
    }

    appointment.status = "cancelled";
    if (reason) appointment.notes = `Cancelled by patient: ${reason}`;
    await appointment.save();

    sendBookingNotification(appointment._id, "cancelled").catch((err) => console.error("Cancellation notification failed:", err));

    await AuditLog.create({
      userId: req.user!.id,
      organizationId: appointment.organizationId || undefined,
      action: "PATIENT_CANCEL_APPOINTMENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { reason: reason || "Self-service cancellation" }
    });

    return reply.code(200).send(successResponse(appointment, "Appointment cancelled successfully"));
  } catch (err) {
    console.error("cancelAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Single Appointment by ID ─────────────────────────────
export async function getAppointmentById(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id)
      .populate("clinicId", "name city address")
      .populate("doctorId", "name specialization fees email phone")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    return reply.code(200).send(successResponse(appointment));
  } catch (err) {
    console.error("getAppointmentById error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Acquire Lock ───────────────────────────────────
export async function lockSlot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { clinicId, doctorId, slotTime } = req.body as {
      clinicId: string;
      doctorId: string;
      slotTime: string;
    };

    if (!clinicId || !doctorId || !slotTime) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, and slotTime are required"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const result = await acquireSlotLock(clinicId, doctorId, slotTime, userId);

    if (!result.success) {
      return reply.code(409).send(errorResponse(result.message, { heldBy: result.heldBy }));
    }

    return reply.code(200).send(
      successResponse(
        {
          lockId: result.lockId,
          lockKey: result.lockKey,
          expiresInSeconds: result.expiresInSeconds,
        },
        result.message
      )
    );
  } catch (err) {
    console.error("lockSlot error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Release Lock ──────────────────────────────────
export async function unlockSlot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { clinicId, doctorId, slotTime, lockId } = req.body as {
      clinicId: string;
      doctorId: string;
      slotTime: string;
      lockId: string;
    };

    if (!clinicId || !doctorId || !slotTime || !lockId) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, slotTime, and lockId are required"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const result = await releaseSlotLock(clinicId, doctorId, slotTime, userId, lockId);

    if (!result.success) {
      return reply.code(403).send(errorResponse(result.message));
    }

    return reply.code(200).send(successResponse(null, result.message));
  } catch (err) {
    console.error("unlockSlot error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Check Lock Status ─────────────────────────────
export async function getSlotLockStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, slotTime } = req.query as {
      clinicId: string;
      doctorId: string;
      slotTime: string;
    };

    if (!clinicId || !doctorId || !slotTime) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, and slotTime are required"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const info = await checkSlotLock(clinicId, doctorId, slotTime);

    return reply.code(200).send(
      successResponse({
        isLocked: info.isLocked,
        heldByUserId: info.heldByUserId || null,
        ttlSeconds: info.ttlSeconds || 0,
      })
    );
  } catch (err) {
    console.error("getSlotLockStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Follow-Up Care-Gap & Patient Recall Register ───────────────
export async function getFollowUpRegister(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, timeframe, search } = (req.query || {}) as {
      clinicId?: string;
      doctorId?: string;
      timeframe?: "all" | "today" | "upcoming" | "overdue";
      search?: string;
    };

    const query: any = {
      $or: [
        { followUpRecommended: true },
        { followUpForAppointmentId: { $exists: true, $ne: null } },
      ],
    };

    if (clinicId) {
      query.clinicId = clinicId;
    } else if (req.user?.organization_id) {
      const { getRequestClinicIds } = await import("../utilities/tenant.ts");
      query.clinicId = { $in: await getRequestClinicIds(req) };
    }

    if (doctorId) {
      query.doctorId = doctorId;
    }

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    const in7Days = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);

    const appointments = await Appointment.find(query)
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      })
      .populate("doctorId", "name specialization")
      .populate("clinicId", "name city")
      .sort({ appointmentTime: 1 })
      .lean();

    let dueTodayCount = 0;
    let upcomingCount = 0;
    let overdueCount = 0;

    const mapped = appointments.map((appt: any) => {
      const apptDate = new Date(appt.appointmentTime);
      let statusCategory: "due_today" | "upcoming" | "overdue" | "attended" = "upcoming";

      if (appt.status === "completed" || appt.status === "in-consultation") {
        statusCategory = "attended";
      } else if (apptDate >= startOfToday && apptDate <= endOfToday) {
        statusCategory = "due_today";
        dueTodayCount++;
      } else if (apptDate > endOfToday && apptDate <= in7Days) {
        statusCategory = "upcoming";
        upcomingCount++;
      } else if (apptDate < startOfToday && ["confirmed", "pending", "checked-in"].includes(appt.status)) {
        statusCategory = "overdue";
        overdueCount++;
      }

      const patientName = appt.patientId?.userId?.name || appt.patientId?.name || "Patient";
      const patientPhone = (appt.patientId as any)?.phone || appt.patientId?.userId?.phone || "";

      return {
        id: appt._id.toString(),
        appointmentTime: appt.appointmentTime,
        status: appt.status,
        statusCategory,
        tokenNumber: appt.tokenNumber,
        patient: {
          id: appt.patientId?._id?.toString() || appt.patientId?.id,
          name: patientName,
          phone: patientPhone,
          gender: appt.patientId?.gender,
          age: appt.patientId?.age,
        },
        doctor: {
          id: appt.doctorId?._id?.toString() || appt.doctorId?.id,
          name: appt.doctorId?.name || "Doctor",
          specialization: appt.doctorId?.specialization || "General Medicine",
        },
        clinic: {
          id: appt.clinicId?._id?.toString() || appt.clinicId?.id,
          name: appt.clinicId?.name || "Clinic",
        },
        diagnosis: appt.diagnosis || "",
        symptoms: appt.symptoms || "",
        notes: appt.notes || "",
        lastRecallSentAt: appt.lastRecallSentAt || null,
        recallCount: appt.recallCount || 0,
      };
    });

    // Filter by timeframe if requested
    let filtered = mapped;
    if (timeframe === "today") {
      filtered = mapped.filter((a: any) => a.statusCategory === "due_today");
    } else if (timeframe === "upcoming") {
      filtered = mapped.filter((a: any) => a.statusCategory === "upcoming");
    } else if (timeframe === "overdue") {
      filtered = mapped.filter((a: any) => a.statusCategory === "overdue");
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      filtered = filtered.filter(
        (a: any) =>
          a.patient.name.toLowerCase().includes(q) ||
          a.patient.phone.includes(q) ||
          a.diagnosis.toLowerCase().includes(q)
      );
    }

    return reply.code(200).send(
      successResponse(
        {
          items: filtered,
          metrics: {
            dueTodayCount,
            upcomingCount,
            overdueCount,
            totalCount: mapped.length,
          },
        },
        "Follow-up recall register retrieved"
      )
    );
  } catch (err: any) {
    req.log.error(err, "Failed to get follow-up register");
    return reply.code(500).send(errorResponse(err.message || "Failed to retrieve follow-up register"));
  }
}

// ─── Dispatch WhatsApp / SMS Follow-Up Reminder ─────────────────
export async function sendFollowUpReminder(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { phone, channel = "whatsapp" } = (req.body || {}) as {
      phone?: string;
      channel?: "whatsapp" | "sms";
    };

    const appointment = await Appointment.findById(id)
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      })
      .populate("doctorId", "name specialization")
      .populate("clinicId", "name city phone");

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const targetPhone =
      phone?.trim() ||
      (appointment.patientId as any)?.phone ||
      (appointment.patientId as any)?.userId?.phone;

    const patientName =
      (appointment.patientId as any)?.name ||
      (appointment.patientId as any)?.userId?.name ||
      "Patient";

    if (!targetPhone) {
      return reply.code(400).send(errorResponse("Patient mobile number not available"));
    }

    try {
      const { sendFollowUpRecallNotification } = await import("../utilities/notifications.ts");
      await sendFollowUpRecallNotification({
        appointmentId: appointment._id.toString(),
        phone: targetPhone,
        channel,
      });
    } catch (msgErr) {
      console.warn("Follow-up reminder dispatch warning:", msgErr);
    }

    (appointment as any).lastRecallSentAt = new Date();
    (appointment as any).recallCount = ((appointment as any).recallCount || 0) + 1;
    await appointment.save();

    await AuditLog.create({
      userId: req.user!.id,
      action: "FOLLOW_UP_RECALL_SENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      category: "CLINICAL_WRITE",
      details: {
        channel,
        phone: targetPhone,
        tokenNumber: appointment.tokenNumber,
        recallCount: (appointment as any).recallCount,
      },
    });

    return reply.code(200).send(
      successResponse(
        {
          id: appointment._id.toString(),
          lastRecallSentAt: (appointment as any).lastRecallSentAt,
          recallCount: (appointment as any).recallCount,
          channel,
        },
        `Follow-up review reminder dispatched to ${patientName} via ${channel.toUpperCase()}`
      )
    );
  } catch (err: any) {
    req.log.error(err, "Failed to send follow-up reminder");
    return reply.code(500).send(errorResponse(err.message || "Failed to send follow-up reminder"));
  }
}

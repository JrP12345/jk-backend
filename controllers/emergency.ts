import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { EmergencyTriage } from "../models/EmergencyTriage.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess } from "../utilities/tenant.ts";

/**
 * Rule-based ESI (Emergency Severity Index) Acuity Calculator
 */
export function recommendESILevel(vitals: any, chiefComplaint: string): 1 | 2 | 3 | 4 | 5 {
  const complaintLower = (chiefComplaint || "").toLowerCase();

  // Level 1: Resuscitation (Immediate life-saving intervention)
  if (
    vitals?.gcsScore !== undefined && vitals.gcsScore < 9 ||
    vitals?.spo2 !== undefined && vitals.spo2 < 88 ||
    vitals?.heartRate !== undefined && vitals.heartRate > 150 ||
    complaintLower.includes("cardiac arrest") ||
    complaintLower.includes("unresponsive") ||
    complaintLower.includes("apnea")
  ) {
    return 1;
  }

  // Level 2: Emergent (High risk, confused, severe pain/distress)
  if (
    vitals?.spo2 !== undefined && vitals.spo2 < 92 ||
    vitals?.heartRate !== undefined && vitals.heartRate > 120 ||
    vitals?.bpSys !== undefined && (vitals.bpSys < 90 || vitals.bpSys > 180) ||
    vitals?.gcsScore !== undefined && vitals.gcsScore < 14 ||
    complaintLower.includes("chest pain") ||
    complaintLower.includes("stroke") ||
    complaintLower.includes("severe bleed") ||
    complaintLower.includes("anaphylaxis")
  ) {
    return 2;
  }

  // Level 3: Urgent (Stable vitals, multiple resources required)
  if (
    vitals?.temperature !== undefined && vitals.temperature > 38.5 ||
    complaintLower.includes("abdominal pain") ||
    complaintLower.includes("fracture") ||
    complaintLower.includes("fever")
  ) {
    return 3;
  }

  // Level 4: Less Urgent (1 resource needed)
  if (complaintLower.includes("suture") || complaintLower.includes("sprain") || complaintLower.includes("rash")) {
    return 4;
  }

  // Level 5: Non-Urgent (No resources needed)
  return 5;
}

export async function createEmergencyTriage(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const {
      patientId,
      clinicId,
      chiefComplaint,
      triageCategory,
      vitals,
      assignedBay,
      attendingDoctorId,
      notes,
      esiLevel: overrideEsi,
    } = req.body as {
      patientId: string;
      clinicId: string;
      chiefComplaint: string;
      triageCategory?: "trauma" | "cardiac" | "respiratory" | "stroke" | "pediatric" | "general";
      vitals?: any;
      assignedBay?: string;
      attendingDoctorId?: string;
      notes?: string;
      esiLevel?: 1 | 2 | 3 | 4 | 5;
    };

    if (!patientId || !clinicId || !chiefComplaint) {
      return reply.code(400).send(errorResponse("patientId, clinicId, and chiefComplaint are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid ObjectID reference"));
    }

    const clinicScope = await checkClinicAccess(req, clinicId);
    if (!clinicScope.allowed) return reply.code(clinicScope.statusCode).send(errorResponse(clinicScope.message));

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    // Auto-calculate ESI acuity level if not explicitly overridden
    const calculatedEsi = recommendESILevel(vitals, chiefComplaint);
    const esiLevel = overrideEsi || calculatedEsi;

    const triage = await EmergencyTriage.create({
      patientId,
      clinicId,
      esiLevel,
      chiefComplaint: chiefComplaint.trim(),
      triageCategory: triageCategory || "general",
      vitals: vitals || {},
      assignedBay: assignedBay?.trim() || "ED Holding",
      attendingDoctorId: attendingDoctorId && mongoose.Types.ObjectId.isValid(attendingDoctorId) ? attendingDoctorId : undefined,
      notes: notes?.trim(),
      status: "triaged",
    });

    await AuditLog.create({
      userId,
      action: esiLevel <= 2 ? "EMERGENCY_CODE_RED_TRIAGE" : "EMERGENCY_TRIAGE_INTAKE",
      targetId: triage._id,
      targetModel: "EmergencyTriage",
      details: { esiLevel, chiefComplaint, assignedBay, isCriticalAlert: esiLevel <= 2 }
    });

    return reply.code(201).send(successResponse({
      ...triage.toObject(),
      isCriticalAlert: esiLevel <= 2,
    }, "Emergency triage intake registered successfully"));
  } catch (err) {
    console.error("createEmergencyTriage error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getEmergencyTriages(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, esiLevel, status, page, limit } = req.query as any;
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};
    if (clinicId) {
      const scope = await checkClinicAccess(req, clinicId);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      filter.clinicId = clinicId;
    } else if (req.user?.role !== "root") {
      const { getRequestClinicIds } = await import("../utilities/tenant.ts");
      filter.clinicId = { $in: await getRequestClinicIds(req) };
    }
    if (esiLevel) filter.esiLevel = parseInt(esiLevel, 10);
    if (status) filter.status = status;

    const totalCount = await EmergencyTriage.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const triages = await EmergencyTriage.find(filter)
      .populate("clinicId", "name city")
      .populate("attendingDoctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone email" }
      })
      .sort({ esiLevel: 1, createdAt: -1 }) // ESI 1 (Resuscitation) first
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(triages));
  } catch (err) {
    console.error("getEmergencyTriages error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateEmergencyTriage(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { status, assignedBay, vitals, attendingDoctorId, notes, esiLevel } = req.body as {
      status?: "triaged" | "under_treatment" | "admitted" | "discharged" | "transferred";
      assignedBay?: string;
      vitals?: any;
      attendingDoctorId?: string;
      notes?: string;
      esiLevel?: 1 | 2 | 3 | 4 | 5;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Emergency Triage ID"));
    }

    const triage = await EmergencyTriage.findById(id);
    if (!triage) {
      return reply.code(404).send(errorResponse("Emergency triage record not found"));
    }

    const scope = await checkOperationalRecordAccess(req, triage);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (status) triage.status = status;
    if (assignedBay !== undefined) triage.assignedBay = assignedBay.trim();
    if (vitals) triage.vitals = { ...triage.vitals, ...vitals };
    if (attendingDoctorId && mongoose.Types.ObjectId.isValid(attendingDoctorId)) {
      triage.attendingDoctorId = new mongoose.Types.ObjectId(attendingDoctorId) as any;
    }
    if (notes !== undefined) triage.notes = notes.trim();
    if (esiLevel) triage.esiLevel = esiLevel;

    await triage.save();

    await AuditLog.create({
      userId,
      action: "EMERGENCY_TRIAGE_UPDATE",
      targetId: triage._id,
      targetModel: "EmergencyTriage",
      details: { status: triage.status, assignedBay: triage.assignedBay, esiLevel: triage.esiLevel }
    });

    return reply.code(200).send(successResponse(triage, "Emergency triage record updated successfully"));
  } catch (err) {
    console.error("updateEmergencyTriage error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

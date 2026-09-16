import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { TeleconsultationSession } from "../models/TeleconsultationSession.ts";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, getRequestClinicIds } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

async function checkPatientSessionOwnership(req: FastifyRequest, patientId: unknown) {
  if (req.user?.role !== "patient") return true;
  const patient = await Patient.findOne({ _id: patientId, userId: req.user.id }).select("_id").lean();
  return Boolean(patient);
}

export async function createTeleSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId } = req.body as { appointmentId: string };

    if (!appointmentId || !mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Valid appointmentId is required"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicAccess = await checkClinicAccess(req, appointment.clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
    if (!(await checkPatientSessionOwnership(req, appointment.patientId))) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    let existing = await TeleconsultationSession.findOne({ appointmentId });
    if (existing) {
      return reply.code(200).send(successResponse(existing, "Existing teleconsultation session retrieved"));
    }

    const sessionRoomId = `TELE-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const meetingBaseUrl = process.env.TELECONSULTATION_BASE_URL?.trim() || "/dashboard/teleconsultation";
    const meetingUrl = meetingBaseUrl.includes("://")
      ? `${meetingBaseUrl.replace(/\/$/, "")}/${sessionRoomId}`
      : `${meetingBaseUrl}?room=${sessionRoomId}`;

    const session = await TeleconsultationSession.create({
      sessionRoomId,
      appointmentId,
      patientId: appointment.patientId,
      doctorId: appointment.doctorId,
      clinicId: appointment.clinicId,
      meetingUrl,
      status: "scheduled",
    });

    await AuditLog.create({
      userId,
      action: "TELECONSULTATION_ROOM_CREATE",
      targetId: session._id,
      targetModel: "TeleconsultationSession",
      details: { sessionRoomId, meetingUrl }
    });

    return reply.code(201).send(successResponse(session, "Teleconsultation video room created successfully"));
  } catch (err) {
    console.error("createTeleSession error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getTeleSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };

    if (!appointmentId || !mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Valid appointmentId is required"));
    }

    const session = await TeleconsultationSession.findOne({ appointmentId })
      .populate("doctorId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone" }
      });

    if (!session) {
      return reply.code(404).send(errorResponse("No teleconsultation session found for this appointment"));
    }

    const sessionAccess = await checkOperationalRecordAccess(req, session);
    if (!sessionAccess.allowed) return sendTenantError(reply, sessionAccess);
    if (!(await checkPatientSessionOwnership(req, session.patientId))) {
      return reply.code(404).send(errorResponse("No teleconsultation session found for this appointment"));
    }

    return reply.code(200).send(successResponse(session));
  } catch (err) {
    console.error("getTeleSession error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function startTeleSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Session ID"));
    }

    const session = await TeleconsultationSession.findById(id);
    if (!session) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    const sessionAccess = await checkOperationalRecordAccess(req, session);
    if (!sessionAccess.allowed) return sendTenantError(reply, sessionAccess);
    if (!(await checkPatientSessionOwnership(req, session.patientId))) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    session.status = "active";
    if (!session.startedAt) {
      session.startedAt = new Date();
    }
    await session.save();

    await Appointment.findByIdAndUpdate(session.appointmentId, { status: "in-consultation" });

    await AuditLog.create({
      userId,
      action: "TELECONSULTATION_ROOM_START",
      targetId: session._id,
      targetModel: "TeleconsultationSession",
      details: { startedAt: session.startedAt }
    });

    return reply.code(200).send(successResponse(session, "Teleconsultation session active"));
  } catch (err) {
    console.error("startTeleSession error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateTeleSessionNotes(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { clinicalNotes, vitalsRecorded } = req.body as {
      clinicalNotes?: string;
      vitalsRecorded?: { bp?: string; pulse?: string; temp?: string; spo2?: string };
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Session ID"));
    }

    const session = await TeleconsultationSession.findById(id);
    if (!session) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    const sessionAccess = await checkOperationalRecordAccess(req, session);
    if (!sessionAccess.allowed) return sendTenantError(reply, sessionAccess);
    if (!(await checkPatientSessionOwnership(req, session.patientId))) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    if (typeof clinicalNotes === "string") {
      session.clinicalNotes = clinicalNotes;
    }
    if (vitalsRecorded && typeof vitalsRecorded === "object") {
      session.vitalsRecorded = {
        ...session.vitalsRecorded,
        ...vitalsRecorded,
      };
    }

    await session.save();

    return reply.code(200).send(successResponse(session, "Clinical notes and vitals updated"));
  } catch (err) {
    console.error("updateTeleSessionNotes error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function endTeleSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Session ID"));
    }

    const session = await TeleconsultationSession.findById(id);
    if (!session) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    const sessionAccess = await checkOperationalRecordAccess(req, session);
    if (!sessionAccess.allowed) return sendTenantError(reply, sessionAccess);
    if (!(await checkPatientSessionOwnership(req, session.patientId))) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    const endedAt = new Date();
    const startedAt = session.startedAt || session.createdAt;
    const durationMinutes = Math.max(1, Math.round((endedAt.getTime() - new Date(startedAt).getTime()) / (1000 * 60)));

    session.status = "ended";
    session.endedAt = endedAt;
    session.durationMinutes = durationMinutes;
    await session.save();

    await Appointment.findByIdAndUpdate(session.appointmentId, { status: "completed" });

    await AuditLog.create({
      userId,
      action: "TELECONSULTATION_ROOM_END",
      targetId: session._id,
      targetModel: "TeleconsultationSession",
      details: { durationMinutes }
    });

    return reply.code(200).send(successResponse(session, `Teleconsultation room ended. Session duration: ${durationMinutes} minutes`));
  } catch (err) {
    console.error("endTeleSession error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getTeleSessions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, status, page, limit } = req.query as any;

    const filter: any = {};
    if (clinicId) {
      if (!mongoose.Types.ObjectId.isValid(clinicId)) return reply.code(400).send(errorResponse("Invalid clinic ID"));
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
      filter.clinicId = clinicId;
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) filter.clinicId = { $in: clinicIds };
    }
    if (status) filter.status = status;

    if (req.user?.role === "patient") {
      const patient = await Patient.findOne({ userId: req.user.id }).select("_id").lean();
      if (!patient) return reply.code(200).send(successResponse([]));
      filter.patientId = patient._id;
    }

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalCount = await TeleconsultationSession.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const sessions = await TeleconsultationSession.find(filter)
      .populate("doctorId", "name specialization")
      .populate("clinicId", "name city")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone" }
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });

    return reply.code(200).send(successResponse(sessions));
  } catch (err) {
    console.error("getTeleSessions error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function postSessionSignal(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { signalType, payload } = req.body as { signalType: string; payload: any };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Session ID"));
    }

    const session = await TeleconsultationSession.findById(id);
    if (!session) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    const sessionAccess = await checkOperationalRecordAccess(req, session);
    if (!sessionAccess.allowed) return sendTenantError(reply, sessionAccess);
    if (!(await checkPatientSessionOwnership(req, session.patientId))) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    const senderRole = req.user?.role || "user";
    if (!session.signals) session.signals = [];

    session.signals.push({
      senderRole,
      signalType,
      payload,
      createdAt: new Date(),
    });

    await session.save();
    return reply.code(200).send(successResponse({ received: true }, "WebRTC signal logged"));
  } catch (err) {
    console.error("postSessionSignal error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getSessionSignals(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Session ID"));
    }

    const session = await TeleconsultationSession.findById(id).select("clinicId patientId organizationId signals");
    if (!session) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    const sessionAccess = await checkOperationalRecordAccess(req, session);
    if (!sessionAccess.allowed) return sendTenantError(reply, sessionAccess);
    if (!(await checkPatientSessionOwnership(req, session.patientId))) {
      return reply.code(404).send(errorResponse("Teleconsultation session not found"));
    }

    return reply.code(200).send(successResponse(session.signals || []));
  } catch (err) {
    console.error("getSessionSignals error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

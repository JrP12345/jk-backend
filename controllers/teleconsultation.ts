import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { TeleconsultationSession } from "../models/TeleconsultationSession.ts";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

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

    let existing = await TeleconsultationSession.findOne({ appointmentId });
    if (existing) {
      return reply.code(200).send(successResponse(existing, "Existing teleconsultation session retrieved"));
    }

    const sessionRoomId = `TELE-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const meetingUrl = `https://meet.healthos.demo/${sessionRoomId}`;

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

    return reply.code(200).send(successResponse(session));
  } catch (err) {
    console.error("getTeleSession error:", err);
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

    const endedAt = new Date();
    const startedAt = session.startedAt || session.createdAt;
    const durationMinutes = Math.max(1, Math.round((endedAt.getTime() - new Date(startedAt).getTime()) / (1000 * 60)));

    session.status = "ended";
    session.endedAt = endedAt;
    session.durationMinutes = durationMinutes;
    await session.save();

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

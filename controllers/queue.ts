import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function getQueue(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date } = req.query as { clinicId: string; doctorId: string; date?: string };

    if (!clinicId || !doctorId) {
      return reply.code(400).send(errorResponse("clinicId and doctorId are required"));
    }

    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    // Get doctor assignment to find average slot duration
    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
    const duration = assignment?.appointmentDuration || 15;

    const appointments = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    })
    .populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    })
    .sort({ queuePosition: 1, tokenNumber: 1 });

    // Calculate Estimated Wait Times
    let waitingAheadCount = 0;
    const queueList = appointments.map((appt: any) => {
      let estimatedWaitTime = 0;
      
      // If the patient is checked-in or scheduled (confirmed/pending) and waiting
      if (appt.status === "pending" || appt.status === "confirmed" || appt.status === "checked-in") {
        estimatedWaitTime = waitingAheadCount * duration;
        waitingAheadCount++;
      }
      
      return {
        ...appt.toJSON(),
        estimatedWaitTime
      };
    });

    return reply.code(200).send(successResponse(queueList));
  } catch (err) {
    console.error("getQueue error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function reorderQueue(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date, orderedAppointmentIds } = req.body as {
      clinicId: string; doctorId: string; date: string; orderedAppointmentIds: string[];
    };

    if (!clinicId || !doctorId || !date || !orderedAppointmentIds || !Array.isArray(orderedAppointmentIds)) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, date, and orderedAppointmentIds array are required"));
    }

    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "receptionist") {
      return reply.code(403).send(errorResponse("Forbidden: only staff can reorder the queue"));
    }

    // Update positions sequentially
    const bulkOps = orderedAppointmentIds.map((id, index) => ({
      updateOne: {
        filter: { _id: id },
        update: { queuePosition: index + 1 }
      }
    }));

    if (bulkOps.length > 0) {
      await Appointment.bulkWrite(bulkOps);
    }

    // Log the override action
    await AuditLog.create({
      userId: req.user!.id,
      action: "VIP_OVERRIDE",
      targetId: new mongoose.Types.ObjectId(clinicId),
      targetModel: "Clinic",
      details: { doctorId, date, orderedAppointmentIds }
    });

    return reply.code(200).send(successResponse(null, "Queue reordered successfully"));
  } catch (err) {
    console.error("reorderQueue error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getAuditLogs(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin") {
      return reply.code(403).send(errorResponse("Forbidden: only admins can view audit logs"));
    }

    const logs = await AuditLog.find()
      .populate("userId", "name email role")
      .sort({ createdAt: -1 })
      .limit(100);

    return reply.code(200).send(successResponse(logs));
  } catch (err) {
    console.error("getAuditLogs error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

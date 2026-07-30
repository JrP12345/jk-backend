import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function processSelfCheckInQr(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId, tokenNumber, clinicId } = req.body as {
      appointmentId?: string;
      tokenNumber?: number;
      clinicId?: string;
    };

    let appointment: any = null;

    if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) {
      appointment = await Appointment.findById(appointmentId)
        .populate("clinicId", "name city")
        .populate("doctorId", "name specialization")
        .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
    } else if (tokenNumber && clinicId) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      appointment = await Appointment.findOne({
        clinicId,
        tokenNumber: Number(tokenNumber),
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      })
        .populate("clinicId", "name city")
        .populate("doctorId", "name specialization")
        .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
    }

    if (!appointment) {
      return reply.code(404).send(errorResponse("No active appointment found for check-in with provided details"));
    }

    if (appointment.status === "checked-in" || appointment.status === "in-consultation") {
      return reply.code(200).send(
        successResponse(
          {
            appointment,
            alreadyCheckedIn: true,
          },
          `Already checked in! Your Queue Token is #${appointment.tokenNumber}`
        )
      );
    }

    if (appointment.status === "cancelled" || appointment.status === "completed") {
      return reply.code(400).send(errorResponse(`Cannot check in for an appointment that is ${appointment.status}`));
    }

    appointment.status = "checked-in";
    await appointment.save();

    // Publish event for real-time queue update
    eventBus.publish({
      eventType: EVENT_TYPES.QUEUE_UPDATED,
      category: "queue",
      targetUserId: appointment.doctorId?._id?.toString() || "",
      title: "Patient Self Checked-In",
      message: `${appointment.patientId?.userId?.name || "Patient"} (Token #${appointment.tokenNumber}) checked in via QR Kiosk.`,
      severity: "info",
      actionUrl: "/dashboard/queue",
      metadata: { appointmentId: appointment._id, tokenNumber: appointment.tokenNumber },
    });

    await AuditLog.create({
      userId: req.user?.id || appointment.patientId?.userId?._id || new mongoose.Types.ObjectId(),
      action: "SELF_CHECKIN_QR",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { tokenNumber: appointment.tokenNumber, clinicId: appointment.clinicId?._id }
    });

    return reply.code(200).send(
      successResponse(
        {
          tokenNumber: appointment.tokenNumber,
          patientName: appointment.patientId?.userId?.name || "Patient",
          doctorName: appointment.doctorId?.name || "Doctor",
          clinicName: appointment.clinicId?.name || "Clinic",
          status: "checked-in",
          checkedInAt: new Date().toISOString(),
        },
        `Self Check-In Successful! Welcome, your Queue Token is #${appointment.tokenNumber}`
      )
    );
  } catch (err) {
    console.error("processSelfCheckInQr error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

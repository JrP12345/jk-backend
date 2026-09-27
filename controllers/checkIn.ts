import { withClinicalTransaction } from "../utilities/transaction.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess } from "../utilities/tenant.ts";

export async function processSelfCheckInQr(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId, tokenNumber, clinicId } = req.body as {
      appointmentId?: string;
      tokenNumber?: number;
      clinicId?: string;
    };

    if (
      !appointmentId ||
      !mongoose.Types.ObjectId.isValid(appointmentId) ||
      tokenNumber === undefined ||
      !Number.isInteger(Number(tokenNumber)) ||
      Number(tokenNumber) < 1 ||
      !clinicId ||
      !mongoose.Types.ObjectId.isValid(clinicId)
    ) {
      return reply.code(400).send(errorResponse("appointmentId, clinicId, and a valid tokenNumber are required"));
    }

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) {
      return reply.code(403).send(errorResponse("Unauthorized clinic access"));
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const appointment: any = await Appointment.findOne({
      _id: appointmentId,
      clinicId,
      tokenNumber: Number(tokenNumber),
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    })
      .populate("clinicId", "name city")
      .populate("doctorId", "name specialization")
      .populate({ path: "patientId", populate: { path: "userId", select: "name" } });

    if (!appointment) {
      return reply.code(404).send(errorResponse("No active appointment found for check-in with provided details"));
    }

    const checkInData = (alreadyCheckedIn: boolean) => ({
      appointmentId: appointment._id.toString(), tokenNumber: appointment.tokenNumber,
      patientName: appointment.patientId?.userId?.name || appointment.patientId?.name || "Patient",
      doctorName: appointment.doctorId?.name || "Doctor", clinicName: appointment.clinicId?.name || "Clinic",
      status: alreadyCheckedIn ? appointment.status : "checked-in", alreadyCheckedIn,
    });
    if (["checked-in", "in-consultation"].includes(appointment.status)) {
      return reply.code(200).send(successResponse(checkInData(true), "This appointment is already checked in"));
    }
    if (!["pending", "confirmed"].includes(appointment.status)) {
      return reply.code(409).send(errorResponse(`Cannot check in an appointment that is ${appointment.status}`));
    }
    await withClinicalTransaction(async () => {
      const changed = await Appointment.updateOne({ _id: appointment._id, status: { $in: ["pending", "confirmed"] } }, { $set: { status: "checked-in" } });
      if (!changed.modifiedCount) throw Object.assign(new Error("Appointment changed. Refresh and try again."), { statusCode: 409 });
      await AuditLog.create({ userId: req.user!.id, action: "SELF_CHECKIN_QR", targetId: appointment._id,
        targetModel: "Appointment", details: { tokenNumber: appointment.tokenNumber, clinicId } });
    });
    const { broadcastQueueUpdate } = await import("../notifications/websocket.ts");
    broadcastQueueUpdate(clinicId, { type: "QUEUE_UPDATED", data: { appointmentId, clinicId, status: "checked-in" }, timestamp: new Date().toISOString() });

    // Publish event for real-time queue update
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.PATIENT_APPOINTMENT_CHECKED_IN,
      category: "patient",
      targetUserId: appointment.doctorId?._id?.toString() || "",
      title: "Patient Self Checked-In",
      message: `${appointment.patientId?.userId?.name || "Patient"} (Token #${appointment.tokenNumber}) checked in via QR Kiosk.`,
      severity: "info",
      actionUrl: "/dashboard/queue",
      metadata: { appointmentId: appointment._id, tokenNumber: appointment.tokenNumber },
    }).catch(err => req.log.error({ err }, "Check-in committed; notification delivery failed"));

    return reply.code(200).send(
      successResponse(
        checkInData(false),
        `Self Check-In Successful! Welcome, your Queue Token is #${appointment.tokenNumber}`
      )
    );
  } catch (err) {
    console.error("processSelfCheckInQr error:", err);
    if ((err as any)?.statusCode === 409) return reply.code(409).send(errorResponse((err as Error).message));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

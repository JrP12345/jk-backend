import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { SurgicalBooking } from "../models/SurgicalBooking.ts";
import { Patient } from "../models/Patient.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess } from "../utilities/tenant.ts";

export async function createSurgicalBooking(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const {
      patientId, clinicId, theatreName, procedureName, leadSurgeonId, anesthesiologistId, scrubNurseName, scheduledStartTime, scheduledEndTime, notes
    } = req.body as {
      patientId: string;
      clinicId: string;
      theatreName: string;
      procedureName: string;
      leadSurgeonId: string;
      anesthesiologistId?: string;
      scrubNurseName?: string;
      scheduledStartTime: string;
      scheduledEndTime: string;
      notes?: string;
    };

    if (!patientId || !clinicId || !theatreName || !procedureName || !leadSurgeonId || !scheduledStartTime || !scheduledEndTime) {
      return reply.code(400).send(errorResponse("patientId, clinicId, theatreName, procedureName, leadSurgeonId, scheduledStartTime, and scheduledEndTime are required"));
    }

    const clinicScope = await checkClinicAccess(req, clinicId);
    if (!clinicScope.allowed) return reply.code(clinicScope.statusCode).send(errorResponse(clinicScope.message));

    const patient = await Patient.findById(patientId);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const startTime = new Date(scheduledStartTime);
    const endTime = new Date(scheduledEndTime);

    if (endTime <= startTime) {
      return reply.code(400).send(errorResponse("scheduledEndTime must be after scheduledStartTime"));
    }

    // Overlapping booking check for OT room and Lead Surgeon
    const overlappingBooking = await SurgicalBooking.findOne({
      clinicId,
      status: { $in: ["scheduled", "in_surgery", "pre_op_prep"] },
      $or: [
        { theatreName: theatreName.trim() },
        { leadSurgeonId }
      ],
      scheduledStartTime: { $lt: endTime },
      scheduledEndTime: { $gt: startTime }
    });

    if (overlappingBooking) {
      return reply.code(400).send(errorResponse("Schedule Conflict: Operating Theatre or Lead Surgeon is already booked during this time window"));
    }

    const booking = await SurgicalBooking.create({
      patientId,
      clinicId,
      theatreName: theatreName.trim(),
      procedureName: procedureName.trim(),
      leadSurgeonId,
      anesthesiologistId: anesthesiologistId || undefined,
      scrubNurseName: scrubNurseName?.trim(),
      scheduledStartTime: new Date(scheduledStartTime),
      scheduledEndTime: new Date(scheduledEndTime),
      notes: notes?.trim(),
      status: "scheduled",
    });

    await AuditLog.create({
      userId,
      action: "OT_BOOKING_CREATE",
      targetId: booking._id,
      targetModel: "SurgicalBooking",
      details: { theatreName, procedureName, scheduledStartTime }
    });

    return reply.code(201).send(successResponse(booking, "Operating Theatre surgical booking scheduled successfully"));
  } catch (err) {
    console.error("createSurgicalBooking error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getSurgicalBookings(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, status, page, limit } = req.query as any;
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
    if (status) filter.status = status;

    const totalCount = await SurgicalBooking.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const bookings = await SurgicalBooking.find(filter)
      .populate("clinicId", "name city")
      .populate("leadSurgeonId", "name specialization")
      .populate("anesthesiologistId", "name specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name phone" }
      })
      .sort({ scheduledStartTime: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(bookings));
  } catch (err) {
    console.error("getSurgicalBookings error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updateSurgicalBookingStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { id } = req.params as { id: string };
    const { status, safetyChecklistComplete } = req.body as {
      status: "scheduled" | "in_progress" | "completed" | "cancelled";
      safetyChecklistComplete?: boolean;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid Booking ID"));
    }

    const booking = await SurgicalBooking.findById(id);
    if (!booking) {
      return reply.code(404).send(errorResponse("Surgical booking not found"));
    }

    const scope = await checkOperationalRecordAccess(req, booking);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));

    if (status) booking.status = status;
    if (safetyChecklistComplete !== undefined) booking.safetyChecklistComplete = safetyChecklistComplete;
    await booking.save();

    await AuditLog.create({
      userId,
      action: "OT_BOOKING_STATUS_UPDATE",
      targetId: booking._id,
      targetModel: "SurgicalBooking",
      details: { status, safetyChecklistComplete }
    });

    return reply.code(200).send(successResponse(booking, `Surgical booking status updated to ${status}`));
  } catch (err) {
    console.error("updateSurgicalBookingStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

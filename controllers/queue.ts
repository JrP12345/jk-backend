import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, getRequestOrganizationId } from "../utilities/tenant.ts";

export async function getQueue(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date } = req.query as { clinicId: string; doctorId: string; date?: string };

    if (!clinicId || !doctorId) {
      return reply.code(400).send(errorResponse("clinicId and doctorId are required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
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

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    if (!mongoose.Types.ObjectId.isValid(doctorId) || orderedAppointmentIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) {
      return reply.code(400).send(errorResponse("Invalid doctor or appointment ID"));
    }

    const targetDate = new Date(date);
    if (Number.isNaN(targetDate.getTime())) {
      return reply.code(400).send(errorResponse("Valid date is required"));
    }
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const uniqueAppointmentIds = new Set(orderedAppointmentIds);
    if (uniqueAppointmentIds.size !== orderedAppointmentIds.length) {
      return reply.code(400).send(errorResponse("orderedAppointmentIds must not contain duplicates"));
    }

    const scopedAppointmentCount = await Appointment.countDocuments({
      _id: { $in: orderedAppointmentIds },
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    });
    if (scopedAppointmentCount !== orderedAppointmentIds.length) {
      return reply.code(403).send(errorResponse("One or more appointments are outside the selected clinic, doctor, or date"));
    }

    const { withTransaction } = await import("../utilities/transaction.ts");

    return await withTransaction(async (session) => {
      const bulkOps = orderedAppointmentIds.map((id, index) => ({
        updateOne: {
          filter: { _id: id, clinicId, doctorId, appointmentTime: { $gte: startOfDay, $lte: endOfDay } },
          update: { queuePosition: index + 1 }
        }
      }));

      if (bulkOps.length > 0) {
        await Appointment.bulkWrite(bulkOps, { session: session || undefined });
      }

      await AuditLog.create([
        {
          userId: req.user!.id,
          action: "VIP_OVERRIDE",
          targetId: new mongoose.Types.ObjectId(clinicId),
          targetModel: "Clinic",
          details: { doctorId, date, orderedAppointmentIds }
        }
      ], { session });

      return reply.code(200).send(successResponse(null, "Queue reordered successfully"));
    });
  } catch (err) {
    console.error("reorderQueue error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getAuditLogs(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    if (userRole !== "admin" && userRole !== "root") {
      return reply.code(403).send(errorResponse("Forbidden: only administrators can view audit logs"));
    }

    const logs = await AuditLog.find()
      .where(req.user?.role === "root" ? {} : { organizationId: getRequestOrganizationId(req) })
      .populate("userId", "name email role")
      .sort({ createdAt: -1 })
      .limit(100);

    return reply.code(200).send(successResponse(logs));
  } catch (err) {
    console.error("getAuditLogs error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function checkInAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const userRole = req.user!.role;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id).populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    // Verify tenant access
    const clinicCheck = await checkClinicAccess(req, appointment.clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    // Patient user can only check in for their own appointment
    const patientUserId = (appointment.patientId as any)?.userId?._id?.toString() || (appointment.patientId as any)?.userId?.id?.toString() || (appointment.patientId as any)?.userId?.toString();
    if (userRole === "patient" && patientUserId !== userId) {
      return reply.code(403).send(errorResponse("Forbidden: You can only check in for your own appointment"));
    }

    if (appointment.status === "completed" || appointment.status === "cancelled") {
      return reply.code(400).send(errorResponse(`Cannot check in for an appointment that is already ${appointment.status}`));
    }

    if (appointment.status === "checked-in" || appointment.status === "in-consultation") {
      return reply.code(200).send(successResponse(appointment, `Patient is already ${appointment.status}`));
    }

    appointment.status = "checked-in";
    await appointment.save();

    const { eventBus } = await import("../events/eventBus.ts");
    const { EVENT_TYPES } = await import("../events/types.ts");

    if (patientUserId) {
      eventBus.publish({
        eventType: EVENT_TYPES.PATIENT_APPOINTMENT_CHECKED_IN,
        category: "patient",
        targetUserId: patientUserId,
        title: "Checked In Successfully ✅",
        message: `You are checked in for your appointment. Token #${appointment.tokenNumber}`,
        severity: "success",
        organizationId: clinicCheck.organizationId || undefined,
        actionUrl: "/dashboard/appointments"
      });
    }

    await AuditLog.create({
      userId,
      action: "PATIENT_CHECK_IN",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { tokenNumber: appointment.tokenNumber, clinicId: appointment.clinicId }
    });

    return reply.code(200).send(successResponse(appointment, `Checked in successfully! Token #${appointment.tokenNumber}`));
  } catch (err) {
    console.error("checkInAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function callNextPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const { clinicId, doctorId } = req.body as { clinicId?: string; doctorId?: string };

    const targetDoctorId = doctorId || (userRole === "doctor" ? userId : null);
    if (!targetDoctorId) {
      return reply.code(400).send(errorResponse("doctorId is required"));
    }

    if (clinicId) {
      const clinicCheck = await checkClinicAccess(req, clinicId);
      if (!clinicCheck.allowed) {
        return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
      }
    } else if (userRole !== "root") {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }

    if (!mongoose.Types.ObjectId.isValid(targetDoctorId)) {
      return reply.code(400).send(errorResponse("Invalid doctor ID"));
    }

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const query: any = {
      doctorId: targetDoctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] }
    };
    if (clinicId) query.clinicId = clinicId;
    else if (req.user?.organization_id) {
      const { getRequestClinicIds } = await import("../utilities/tenant.ts");
      query.clinicId = { $in: await getRequestClinicIds(req) };
    }

    const waitingAppts = await Appointment.find(query)
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      })
      .populate("clinicId", "name city");

    if (waitingAppts.length === 0) {
      return reply.code(200).send(successResponse(null, "No waiting patients in queue for today"));
    }

    // Deterministic Status Priority: checked-in (1) > confirmed (2) > pending (3)
    const getStatusPriority = (s: string) => {
      if (s === "checked-in") return 1;
      if (s === "confirmed") return 2;
      return 3;
    };

    waitingAppts.sort((a, b) => {
      const pA = getStatusPriority(a.status);
      const pB = getStatusPriority(b.status);
      if (pA !== pB) return pA - pB;
      const qA = a.queuePosition ?? a.tokenNumber ?? 999;
      const qB = b.queuePosition ?? b.tokenNumber ?? 999;
      if (qA !== qB) return qA - qB;
      return (a.tokenNumber || 0) - (b.tokenNumber || 0);
    });

    const nextAppt = waitingAppts[0];

    nextAppt.status = "in-consultation";
    await nextAppt.save();

    const { Encounter } = await import("../models/Encounter.ts");
    const existingEncounter = await Encounter.findOne({ appointmentId: nextAppt._id });
    if (!existingEncounter) {
      await Encounter.create({
        organizationId: (nextAppt as any).organizationId || (nextAppt.clinicId as any)?.organizationId,
        clinicId: (nextAppt.clinicId as any)?._id || nextAppt.clinicId,
        appointmentId: nextAppt._id,
        patientId: (nextAppt.patientId as any)?._id || nextAppt.patientId,
        doctorId: nextAppt.doctorId,
        encounterType: nextAppt.appointmentType === "online" ? "telehealth" : "opd",
        status: "in_progress",
        startedAt: new Date(),
      });
    }

    const { eventBus } = await import("../events/eventBus.ts");
    const { EVENT_TYPES } = await import("../events/types.ts");

    const patientUserId = (nextAppt.patientId as any)?.userId?._id?.toString() || (nextAppt.patientId as any)?.userId?.toString();
    if (patientUserId) {
      eventBus.publish({
        eventType: EVENT_TYPES.PATIENT_CALL_NEXT,
        category: "patient",
        targetUserId: patientUserId,
        title: "Called for Consultation 🩺",
        message: `Please proceed to consultation room. Token #${nextAppt.tokenNumber}`,
        severity: "info",
        actionUrl: "/dashboard/appointments"
      });
    }

    await AuditLog.create({
      userId,
      action: "PATIENT_CALL_NEXT",
      targetId: nextAppt._id,
      targetModel: "Appointment",
      details: { tokenNumber: nextAppt.tokenNumber, status: "in-consultation" }
    });

    return reply.code(200).send(successResponse(nextAppt, `Calling Token #${nextAppt.tokenNumber}`));
  } catch (err) {
    console.error("callNextPatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

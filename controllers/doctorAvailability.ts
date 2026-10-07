import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { Appointment } from "../models/Appointment.ts";
import { Location } from "../models/Location.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkLocationAccess, checkPatientAccess, checkOperationalRecordAccess, getRequestLocationIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { hasValidTrackerCapability } from "../utilities/publicTracker.ts";
import { locationDateKey, locationDayRange, locationLocalTimeToDate, getLocationTimezone } from "../utilities/locationTime.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";
import { disruptionService } from "../services/disruptionService.ts";
import { AppointmentDomainError } from "../services/AppointmentService.ts";

export async function setDoctorDayOverride(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const {
      locationId,
      doctorId,
      date,
      status,
      effectiveStartTime,
      effectiveEndTime,
      reason,
    } = req.body as {
      locationId: string;
      doctorId: string;
      date: string;
      status: "available" | "unavailable" | "delayed" | "extended";
      effectiveStartTime?: string;
      effectiveEndTime?: string;
      reason?: string;
    };

    if (!locationId || !doctorId || !date || !status) {
      return reply.code(400).send(errorResponse("locationId, doctorId, date, and status are required"));
    }
    if (!mongoose.Types.ObjectId.isValid(doctorId)) return reply.code(400).send(errorResponse("Invalid doctor ID"));

    if (!["available", "unavailable", "delayed", "extended"].includes(status)) {
      return reply.code(400).send(errorResponse("Invalid status value"));
    }

    // Only the doctor themselves, or staff (receptionist/admin/root) can set overrides
    if (userRole === "doctor" && userId !== doctorId) {
      return reply.code(403).send(errorResponse("Doctors can only modify their own availability"));
    }

    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    let targetLocations: string[] = [];
    if (locationId === "all") {
      const assignments = await DoctorAssignment.find({
        $or: [{ doctorId }, { doctorId: mongoose.Types.ObjectId.isValid(doctorId) ? new mongoose.Types.ObjectId(doctorId) : doctorId }],
        isActive: true,
        ...(scope.organizationId ? { organizationId: scope.organizationId } : {}),
      });
      targetLocations = Array.from(new Set(assignments.map((a) => a.locationId.toString())));
      if (targetLocations.length === 0) {
        return reply.code(400).send(errorResponse("No active location assignments found for this doctor"));
      }
    } else {
      const locationCheck = await checkLocationAccess(req, locationId);
      if (!locationCheck.allowed) {
        return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
      }
      targetLocations = [locationId];
    }

    // An override must target an active assignment, not merely a known user ID.
    const assigned = await DoctorAssignment.find({ doctorId, locationId: { $in: targetLocations }, isActive: true }).select("locationId").lean();
    const assignedLocations = new Set(assigned.map(assignment => String(assignment.locationId)));
    if (targetLocations.some(id => !assignedLocations.has(id))) {
      return reply.code(404).send(errorResponse("Active doctor assignment not found"));
    }
    const locationChecks = await Promise.all(targetLocations.map(id => checkLocationAccess(req, id)));
    for (const check of locationChecks) {
      if (!check.allowed) return reply.code(check.statusCode).send(errorResponse(check.message));
      if (scope.organizationId && check.organizationId !== scope.organizationId) return reply.code(404).send(errorResponse("Location not found"));
    }
    for (const targetLocation of targetLocations) {
      const timezone = await getLocationTimezone(targetLocation);
      try {
        locationDayRange(date, timezone);
        if (effectiveStartTime) locationLocalTimeToDate(date, effectiveStartTime, timezone);
        if (effectiveEndTime) locationLocalTimeToDate(date, effectiveEndTime, timezone);
      } catch { return reply.code(400).send(errorResponse("Invalid location date or time")); }
    }

    const createdOverrides = [];
    let lastDisruptionSummary: any = null;

    for (const cId of targetLocations) {
      const locationCheck = await checkLocationAccess(req, cId);
      if (!locationCheck.allowed) continue;

      const orgId = locationCheck.organizationId || req.user?.organization_id;

      const override = await DoctorDayOverride.findOneAndUpdate(
        { locationId: cId, doctorId, date },
        {
          locationId: cId,
          doctorId,
          organizationId: orgId || null,
          date,
          status,
          effectiveStartTime: effectiveStartTime || null,
          effectiveEndTime: effectiveEndTime || null,
          reason: reason || null,
          createdBy: userId,
        },
        { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
      );

      createdOverrides.push(override);

      // Process Disruption and Patient Triage via disruptionService
      let disruptionSummary: any = null;
      if (status === "unavailable" || effectiveEndTime) {
        disruptionSummary = await disruptionService.processDoctorDisruption({
          locationId: cId,
          doctorId,
          date,
          status,
          effectiveStartTime,
          effectiveEndTime,
          reason,
          userId,
          organizationId: orgId || null,
          disruptionId: override._id,
        });
        lastDisruptionSummary = disruptionSummary;
      }

      // Audit Log
      await AuditLog.create({
        userId,
        action: "DOCTOR_DAY_OVERRIDE_SET",
        targetId: override._id,
        targetModel: "DoctorDayOverride",
        details: {
          locationId: cId,
          doctorId,
          date,
          status,
          effectiveStartTime,
          effectiveEndTime,
          disruptionSummary,
        },
      });

      // Real-time queue broadcast
      broadcastQueueUpdate(cId, {
        type: "QUEUE_UPDATED",
        data: {
          locationId: cId,
          doctorId,
          date,
          overrideStatus: status,
          effectiveStartTime,
          effectiveEndTime,
        },
        message: `Doctor availability changed: ${status}`,
        timestamp: new Date().toISOString(),
      });
    }

    return reply.code(200).send(
      successResponse(
        {
          override: createdOverrides[0],
          overrides: createdOverrides,
          affectedSummary: lastDisruptionSummary || {
            inConsultationPreservedCount: 0,
            checkedInTriageCount: 0,
            remoteNotifiedCount: 0,
          },
        },
        `Doctor availability override set successfully for ${createdOverrides.length} location(s)`
      )
    );
  } catch (err) {
    console.error("setDoctorDayOverride error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getDoctorDayOverrides(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, doctorId, date, startDate, endDate } = req.query as {
      locationId?: string;
      doctorId?: string;
      date?: string;
      startDate?: string;
      endDate?: string;
    };

    if (locationId && locationId !== "all") {
      const locationCheck = await checkLocationAccess(req, locationId);
      if (!locationCheck.allowed) {
        return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
      }
    }

    const consumer = ["patient", "family_member", "guest"].includes(req.user?.role || "");
    if (consumer && (!locationId || locationId === "all" || !doctorId)) {
      return reply.code(400).send(errorResponse("A location and doctor are required"));
    }
    const filter: any = {};
    if (!consumer) {
      const scope = resolveAuthorizedOrganizationScope(req);
      if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
      // Older overrides omit organizationId; their owning location remains authority.
      if (scope.organizationId) filter.$or = [{ organizationId: scope.organizationId }, { organizationId: null }];
      const locationIds = scope.organizationId
        ? (await Location.find({ organizationId: scope.organizationId, isActive: { $ne: false } }).select("_id").lean()).map(location => String(location._id))
        : await getRequestLocationIds(req);
      if (locationIds) filter.locationId = { $in: locationIds };
    }
    if (locationId && locationId !== "all") filter.locationId = filter.locationId ? { ...filter.locationId, $eq: locationId } : locationId;
    if (doctorId) filter.doctorId = doctorId;

    if (date) {
      filter.date = date;
    } else if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = startDate;
      if (endDate) filter.date.$lte = endDate;
    }

    const overrides = await DoctorDayOverride.find(filter)
      .select(consumer ? "locationId doctorId date status effectiveStartTime effectiveEndTime" : "")
      .populate("doctorId", consumer ? "name specialization" : "name email phone specialization")
      .populate("locationId", "name city")
      .sort({ date: 1 });

    return reply.code(200).send(successResponse(overrides));
  } catch (err) {
    console.error("getDoctorDayOverrides error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function deleteDoctorDayOverride(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const userRole = req.user!.role;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid override ID"));
    }

    const override = await DoctorDayOverride.findById(id);
    if (!override) {
      return reply.code(404).send(errorResponse("Override not found"));
    }

    const locationCheck = await checkOperationalRecordAccess(req, override);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }

    if (userRole === "doctor" && userId !== override.doctorId.toString()) {
      return reply.code(403).send(errorResponse("Doctors can only delete their own overrides"));
    }

    await override.deleteOne();

    await AuditLog.create({
      userId,
      action: "DOCTOR_DAY_OVERRIDE_DELETE",
      targetId: override._id,
      targetModel: "DoctorDayOverride",
      details: { locationId: override.locationId, doctorId: override.doctorId, date: override.date },
    });

    broadcastQueueUpdate(override.locationId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        locationId: override.locationId.toString(),
        doctorId: override.doctorId.toString(),
        date: override.date,
        overrideStatus: "reverted_to_default",
      },
      message: "Doctor override removed; returned to standard schedule",
      timestamp: new Date().toISOString(),
    });

    return reply.code(200).send(successResponse(null, "Doctor availability override removed successfully"));
  } catch (err) {
    console.error("deleteDoctorDayOverride error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getTriageAppointments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, doctorId, date } = req.query as {
      locationId: string;
      doctorId?: string;
      date?: string;
    };

    if (!locationId) {
      return reply.code(400).send(errorResponse("locationId is required"));
    }

    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }

    const query: any = {
      locationId,
      organizationId: locationCheck.organizationId,
      status: "disruption_triage",
    };

    if (doctorId) query.doctorId = doctorId;

    if (date) {
      const timezone = await getLocationTimezone(locationId);
      try {
        const { start, end } = locationDayRange(date, timezone);
        query.appointmentTime = { $gte: start, $lte: end };
      } catch { return reply.code(400).send(errorResponse("Invalid location date")); }
    }

    const appointments = await Appointment.find(query)
      .populate("doctorId", "name email specialization")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      })
      .sort({ tokenNumber: 1, appointmentTime: 1 });

    return reply.code(200).send(successResponse(appointments));
  } catch (err) {
    console.error("getTriageAppointments error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getEligibleReplacements(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, doctorId, date } = req.query as {
      locationId: string;
      doctorId: string;
      date?: string;
    };

    if (!locationId || !doctorId) {
      return reply.code(400).send(errorResponse("locationId and doctorId are required"));
    }

    const locationCheck = await checkLocationAccess(req, locationId);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }

    const timezone = await getLocationTimezone(locationId);
    const targetDate = date || locationDateKey(new Date(), timezone);
    try { locationDayRange(targetDate, timezone); }
    catch { return reply.code(400).send(errorResponse("Invalid location date")); }
    const eligible = await disruptionService.getEligibleReplacementDoctors(locationId, targetDate, doctorId);

    return reply.code(200).send(successResponse(eligible));
  } catch (err) {
    console.error("getEligibleReplacements error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function triageTransferAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId, replacementDoctorId, reason } = req.body as {
      appointmentId: string;
      replacementDoctorId: string;
      reason?: string;
    };

    if (!appointmentId || !replacementDoctorId) {
      return reply.code(400).send(errorResponse("appointmentId and replacementDoctorId are required"));
    }

    const appt = await Appointment.findById(appointmentId);
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const locationCheck = await checkOperationalRecordAccess(req, appt);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }

    const updated = await disruptionService.transferPatient({
      appointmentId,
      replacementDoctorId,
      transferredByUserId: userId,
      reason,
    });

    return reply.code(200).send(successResponse(updated, "Patient transferred to replacement doctor successfully"));
  } catch (err: any) {
    console.error("triageTransferAppointment error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : err.code === 11000 ? 409 : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : err.code === 11000 ? "The selected appointment slot is no longer available" : "Internal server error"));
  }
}

export async function triageCancelAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId, reason } = req.body as {
      appointmentId: string;
      reason?: string;
    };

    if (!appointmentId) {
      return reply.code(400).send(errorResponse("appointmentId is required"));
    }

    const appt = await Appointment.findById(appointmentId);
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const locationCheck = await checkOperationalRecordAccess(req, appt);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }

    const updated = await disruptionService.cancelByDisruption({
      appointmentId,
      cancelledByUserId: userId,
      reason,
    });

    return reply.code(200).send(successResponse(updated, "Appointment cancelled successfully"));
  } catch (err: any) {
    console.error("triageCancelAppointment error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : err.code === 11000 ? 409 : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : err.code === 11000 ? "The selected appointment slot is no longer available" : "Internal server error"));
  }
}

export async function triageRescheduleAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId, targetDate, targetDoctorId, targetTimeSlot, reason } = req.body as {
      appointmentId: string;
      targetDate: string;
      targetDoctorId?: string;
      targetTimeSlot?: string;
      reason?: string;
    };

    if (!appointmentId || !targetDate) {
      return reply.code(400).send(errorResponse("appointmentId and targetDate are required"));
    }

    const appt = await Appointment.findById(appointmentId);
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const locationCheck = await checkOperationalRecordAccess(req, appt);
    if (!locationCheck.allowed) {
      return reply.code(locationCheck.statusCode).send(errorResponse(locationCheck.message));
    }

    const result = await disruptionService.priorityReschedule({
      appointmentId,
      targetDate,
      targetDoctorId,
      targetTimeSlot,
      rescheduledByUserId: userId,
      reason,
    });

    return reply.code(200).send(successResponse(result, "Appointment rescheduled successfully with high priority"));
  } catch (err: any) {
    console.error("triageRescheduleAppointment error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : err.code === 11000 ? 409 : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : err.code === 11000 ? "The selected appointment slot is no longer available" : "Internal server error"));
  }
}

export async function triageBatchAction(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { action, appointmentIds, replacementDoctorId, targetDate, targetTimeSlot, reason } = req.body as {
      action: "transfer" | "cancel" | "reschedule";
      appointmentIds: string[];
      replacementDoctorId?: string;
      targetDate?: string;
      targetTimeSlot?: string;
      reason?: string;
    };

    if (!action || !appointmentIds || !Array.isArray(appointmentIds) || appointmentIds.length === 0) {
      return reply.code(400).send(errorResponse("action and non-empty appointmentIds array are required"));
    }

    if (!["transfer", "cancel", "reschedule"].includes(action) || appointmentIds.length > 100
      || appointmentIds.some(id => typeof id !== "string" || !mongoose.Types.ObjectId.isValid(id))) {
      return reply.code(400).send(errorResponse("Use a valid action and at most 100 appointment IDs"));
    }
    if (action === "transfer" && !replacementDoctorId || action === "reschedule" && !targetDate) {
      return reply.code(400).send(errorResponse("The target doctor or date is required for this action"));
    }
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const uniqueIds = Array.from(new Set(appointmentIds));
    const records = await Appointment.find({ _id: { $in: uniqueIds } }).select("locationId organizationId").lean();
    if (records.length !== uniqueIds.length) return reply.code(404).send(errorResponse("Appointment not found"));
    // All targets must be authorized before the first mutation or refund.
    const allowedLocations = new Set<string>();
    for (const record of records) {
      if (scope.organizationId && String(record.organizationId) !== scope.organizationId) {
        return reply.code(404).send(errorResponse("Appointment not found"));
      }
      const location = String(record.locationId);
      if (!allowedLocations.has(location)) {
        const check = await checkOperationalRecordAccess(req, record);
        if (!check.allowed) return reply.code(check.statusCode).send(errorResponse(check.message));
        allowedLocations.add(location);
      }
    }

    const result = await disruptionService.batchTriageAction({
      action,
      appointmentIds: uniqueIds,
      actorUserId: userId,
      replacementDoctorId,
      targetDate,
      targetTimeSlot,
      reason,
    });

    return reply.code(200).send(successResponse(result, "Batch triage action completed"));
  } catch (err: any) {
    console.error("triageBatchAction error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : err.code === 11000 ? 409 : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : err.code === 11000 ? "The selected appointment slot is no longer available" : "Internal server error"));
  }
}

export async function patientDisruptionAction(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId, action, targetDate, targetTimeSlot, reason } = req.body as {
      appointmentId: string;
      action: "reschedule" | "cancel";
      targetDate?: string;
      targetTimeSlot?: string;
      reason?: string;
    };

    if (!appointmentId || !action) {
      return reply.code(400).send(errorResponse("appointmentId and action are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appt = await Appointment.findById(appointmentId).select("+trackerTokenHash");
    if (!appt) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    let authorized = hasValidTrackerCapability(req, appt);
    if (!authorized && req.user && ["patient", "family_member", "guest"].includes(req.user.role)) {
      authorized = appt.bookedByUserId?.toString() === req.user.id;
      if (!authorized && req.user.role !== "guest") authorized = (await checkPatientAccess(req, String(appt.patientId))).allowed;
    }
    if (!authorized) return reply.code(403).send(errorResponse("A valid private tracker link or appointment owner session is required"));
    if (appt.status !== "disruption_triage") return reply.code(409).send(errorResponse("Appointment is no longer awaiting a disruption response"));

    const actorId = req.user?.id || "patient";

    if (action === "reschedule") {
      if (!targetDate) {
        return reply.code(400).send(errorResponse("targetDate is required for rescheduling"));
      }
      const result = await disruptionService.priorityReschedule({
        appointmentId,
        targetDate,
        targetTimeSlot,
        rescheduledByUserId: actorId,
        reason: reason || "Patient self-service reschedule following disruption",
      });
      return reply.code(200).send(successResponse(result, "Appointment rescheduled successfully"));
    } else if (action === "cancel") {
      const result = await disruptionService.cancelByDisruption({
        appointmentId,
        cancelledByUserId: actorId,
        reason: reason || "Patient self-service cancellation following disruption",
      });
      return reply.code(200).send(successResponse(result, "Appointment cancelled successfully"));
    } else {
      return reply.code(400).send(errorResponse("Invalid action. Must be 'reschedule' or 'cancel'"));
    }
  } catch (err: any) {
    console.error("patientDisruptionAction error:", err);
    return reply.code(err instanceof AppointmentDomainError ? err.statusCode : err.code === 11000 ? 409 : 500).send(errorResponse(err instanceof AppointmentDomainError ? err.message : err.code === 11000 ? "The selected appointment slot is no longer available" : "Internal server error"));
  }
}

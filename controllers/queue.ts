import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { getActiveConsultationDoctorDayKey, isActiveConsultationLockConflict } from "../utilities/consultationLock.ts";
import { Patient } from "../models/Patient.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, getRequestOrganizationId } from "../utilities/tenant.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { SmsWhatsAppService } from "../services/SmsWhatsAppService.ts";
import { verifyAuditChainIntegrity } from "../services/AuditTrailService.ts";
import { issueAppointmentTrackerLink } from "../utilities/publicTracker.ts";
import { runNoShowSweep } from "../jobs/noShowSweepJob.ts";

/**
 * Calculates adaptive consultation duration based on today's completed encounters for doctor and clinic.
 * Returns rolling average (in minutes) if >= 2 consultations completed today, otherwise fallbackDuration.
 */
export async function getAdaptiveConsultationDuration(
  clinicId: string | mongoose.Types.ObjectId,
  doctorId: string | mongoose.Types.ObjectId,
  startOfDay: Date,
  endOfDay: Date,
  fallbackDuration: number
): Promise<{ duration: number; isAdaptive: boolean; sampleCount: number }> {
  try {
    const { Encounter } = await import("../models/Encounter.ts");
    const completed = await Encounter.find({
      clinicId,
      doctorId,
      status: "completed",
      startedAt: { $exists: true, $ne: null },
      endedAt: { $exists: true, $ne: null },
      createdAt: { $gte: startOfDay, $lte: endOfDay }
    }).select("startedAt endedAt").lean();

    if (completed.length >= 2) {
      let totalMinutes = 0;
      let validCount = 0;
      for (const enc of completed) {
        if (enc.startedAt && enc.endedAt) {
          const diffMs = new Date(enc.endedAt).getTime() - new Date(enc.startedAt).getTime();
          const diffMinutes = Math.round(diffMs / (60 * 1000));
          // Sanity filter: consultation between 2 and 120 minutes
          if (diffMinutes >= 2 && diffMinutes <= 120) {
            totalMinutes += diffMinutes;
            validCount++;
          }
        }
      }

      if (validCount >= 2) {
        const todayAvg = totalMinutes / validCount;
        // Damped Hybrid Consultation Duration:
        // Baseline = 0.6 * fallbackDuration + 0.4 * todayAvg
        // Clamped by [0.75 * fallbackDuration, 1.5 * fallbackDuration]
        const rawHybrid = 0.6 * fallbackDuration + 0.4 * todayAvg;
        const minBound = Math.max(3, Math.round(0.75 * fallbackDuration));
        const maxBound = Math.round(1.5 * fallbackDuration);
        const boundedHybrid = Math.max(minBound, Math.min(maxBound, Math.round(rawHybrid)));
        return { duration: boundedHybrid, isAdaptive: true, sampleCount: validCount };
      }
    }
  } catch (err) {
    console.error("getAdaptiveConsultationDuration error (fallback used):", err);
  }

  return { duration: fallbackDuration, isAdaptive: false, sampleCount: 0 };
}

/**
 * Automatically sweeps through today's appointments and marks un-arrived patients as no-show
 * if their scheduled slot time has passed by more than 30 minutes without check-in.
 */
export async function autoDetectNoShows(
  clinicId: string | mongoose.Types.ObjectId,
  _doctorId?: string | mongoose.Types.ObjectId,
  _startOfDay?: Date,
  _endOfDay?: Date
): Promise<number> {
  const result = await runNoShowSweep({ clinicId: clinicId.toString() });
  return result.sweptCount;
}

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

    // Get doctor assignment to find default duration
    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
    const defaultDuration = assignment?.appointmentDuration || 15;

    // Calculate adaptive consultation duration based on today's actual completed encounters
    const { duration, isAdaptive, sampleCount } = await getAdaptiveConsultationDuration(
      clinicId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );

    // Pure read query: no mutations executed on GET requests (Step 5.1 hardened)
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

    // Deduct elapsed time from in-consultation patient
    const inConsultationAppt = appointments.find((a: any) => a.status === "in-consultation");
    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter } = await import("../models/Encounter.ts");
      const activeEncounter = await Encounter.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1000));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }

    // Calculate Estimated Wait Times
    let waitingAheadCount = 0;
    const queueList = appointments.map((appt: any) => {
      let estimatedWaitTime = 0;
      
      // If the patient is checked-in or scheduled (confirmed/pending) and waiting
      if (appt.status === "pending" || appt.status === "confirmed" || appt.status === "checked-in") {
        estimatedWaitTime = inConsultationRemainingMinutes + (waitingAheadCount * duration);
        waitingAheadCount++;
      }
      
      return {
        ...appt.toJSON(),
        estimatedWaitTime,
        isAdaptiveDuration: isAdaptive,
      };
    });

    return reply.code(200).send(successResponse(queueList));
  } catch (err) {
    console.error("getQueue error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getQueueStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date } = req.query as { clinicId: string; doctorId: string; date?: string };

    if (!clinicId || !doctorId) {
      return reply.code(400).send(errorResponse("clinicId and doctorId are required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
    const defaultDuration = assignment?.appointmentDuration || 15;
    const bookingMode = (assignment as any)?.bookingMode || "sequential_queue";
    const maxDailyTokens = (assignment as any)?.maxDailyTokens || null;

    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

    // Calculate adaptive consultation duration based on today's actual completed encounters
    const { duration, isAdaptive, sampleCount } = await getAdaptiveConsultationDuration(
      clinicId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );

    // Automatically sweep and mark no-shows for past-due un-arrived appointments today
    await autoDetectNoShows(clinicId, doctorId, startOfDay, endOfDay);

    const appointments = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $nin: ["cancelled", "disruption_triage"] }
    }).sort({ queuePosition: 1, tokenNumber: 1 });

    const totalBooked = appointments.length;
    const nextToken = totalBooked + 1;

    // Currently serving token and elapsed duration calculation
    const inConsultationAppt = appointments.find((a) => a.status === "in-consultation");
    const currentlyServing = inConsultationAppt ? inConsultationAppt.tokenNumber : null;

    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter } = await import("../models/Encounter.ts");
      const activeEncounter = await Encounter.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1000));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }

    // Patient specific calculation if authenticated patient
    let myToken: number | null = null;
    let myStatus: string | null = null;
    let peopleAhead = 0;
    let estimatedWaitMinutes = 0;

    if (req.user?.role === "patient" && req.user?.id) {
      const { Patient } = await import("../models/Patient.ts");
      const patient = await Patient.findOne({ userId: req.user.id });
      if (patient) {
        const myAppt = appointments.find((a) => a.patientId.toString() === patient._id.toString());
        if (myAppt) {
          myToken = myAppt.tokenNumber;
          myStatus = myAppt.status;

          // Count active appointments ahead of me that haven't been completed or cancelled
          const waitingStatuses = ["pending", "confirmed", "checked-in"];
          if (waitingStatuses.includes(myAppt.status)) {
            peopleAhead = appointments.filter((a) => {
              const isAhead = (a.queuePosition ?? a.tokenNumber) < (myAppt.queuePosition ?? myAppt.tokenNumber);
              const isWaitingOrInConsultation = [...waitingStatuses, "in-consultation"].includes(a.status);
              return isAhead && isWaitingOrInConsultation;
            }).length;

            estimatedWaitMinutes = inConsultationRemainingMinutes + (peopleAhead * duration);
          }
        }
      }
    }

    const { OpdSession } = await import("../models/OpdSession.ts");
    const sessionDateStr = date ? date.slice(0, 10) : new Date().toISOString().slice(0, 10);
    const opdSession = await OpdSession.findOne({
      clinicId,
      doctorId,
      date: sessionDateStr,
    }).lean();

    return reply.code(200).send(
      successResponse({
        clinicId,
        doctorId,
        date: targetDate.toISOString().slice(0, 10),
        bookingMode,
        currentlyServing,
        totalBooked,
        nextToken,
        averageDuration: duration,
        isAdaptiveDuration: isAdaptive,
        adaptiveSampleCount: sampleCount,
        maxDailyTokens,
        myToken,
        myStatus,
        peopleAhead,
        estimatedWaitMinutes,
        opdSession: opdSession || { status: "not_started", date: targetDate.toISOString().slice(0, 10) },
      })
    );
  } catch (err) {
    console.error("getQueueStatus error:", err);
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

      broadcastQueueUpdate(clinicId, {
        type: "QUEUE_UPDATED",
        data: { clinicId, doctorId, date, action: "REORDERED" },
        timestamp: new Date().toISOString(),
      });

      return reply.code(200).send(successResponse(null, "Queue reordered successfully"));
    });
  } catch (err) {
    console.error("reorderQueue error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getAuditLogs(req: FastifyRequest, reply: FastifyReply) {
  try {
    const filter: any = {};
    const query = req.query as Record<string, string | number | undefined>;

    if (req.user?.role !== "root") {
      const orgId = getRequestOrganizationId(req);
      if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
      filter.organizationId = orgId;
    } else {
      // Root: apply optional organization/clinic scope filters
      if (query.clinicId && mongoose.Types.ObjectId.isValid(String(query.clinicId))) {
        const clinic = await Clinic.findById(String(query.clinicId)).select("organizationId").lean();
        if (clinic?.organizationId) {
          filter.organizationId = clinic.organizationId;
        }
      } else if (query.organizationId && mongoose.Types.ObjectId.isValid(String(query.organizationId))) {
        filter.organizationId = String(query.organizationId);
      }
    }

    // Shared filters (available to all authorized callers)
    if (query.doctorId && mongoose.Types.ObjectId.isValid(String(query.doctorId))) {
      filter.userId = new mongoose.Types.ObjectId(String(query.doctorId));
    }
    if (query.category && typeof query.category === "string") {
      filter.category = query.category;
    }
    if (query.action && typeof query.action === "string") {
      filter.action = query.action;
    }
    if (query.startDate || query.endDate) {
      filter.createdAt = {};
      if (query.startDate) {
        const start = new Date(String(query.startDate));
        if (!isNaN(start.getTime())) filter.createdAt.$gte = start;
      }
      if (query.endDate) {
        const end = new Date(String(query.endDate));
        if (!isNaN(end.getTime())) {
          // Include the entire end day
          end.setHours(23, 59, 59, 999);
          filter.createdAt.$lte = end;
        }
      }
      if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }

    const { page, limit } = query as { page?: string | number; limit?: string | number };
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const totalCount = await AuditLog.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const logs = await AuditLog.find(filter)
      .populate("userId", "name email role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });

    return reply.code(200).send(successResponse(logs));
  } catch (err) {
    console.error("getAuditLogs error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function verifyAuditLogsIntegrity(req: FastifyRequest, reply: FastifyReply) {
  try {
    let orgId: string | null = null;
    if (req.user?.role !== "root") {
      const tenantOrgId = getRequestOrganizationId(req);
      if (!tenantOrgId) return reply.code(403).send(errorResponse("Organization context is required"));
      orgId = tenantOrgId.toString();
    } else {
      const queryOrgId = (req.query as any)?.organizationId;
      if (queryOrgId) orgId = String(queryOrgId);
    }

    const verification = await verifyAuditChainIntegrity(orgId);
    return reply.code(200).send(successResponse(verification));
  } catch (err: any) {
    console.error("verifyAuditLogsIntegrity error:", err);
    return reply.code(500).send(errorResponse(err?.message || "Internal server error"));
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

    let appointment = await Appointment.findById(id).populate({
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

    // Consumer accounts may only check in themselves or a linked family member.
    const patientUserId = (appointment.patientId as any)?.userId?._id?.toString() || (appointment.patientId as any)?.userId?.id?.toString() || (appointment.patientId as any)?.userId?.toString();
    if (["patient", "family_member", "guest"].includes(userRole)) {
      const isBookingOwner = String((appointment as any).bookedByUserId || "") === String(userId);
      const ownsPatient = await Patient.exists({ _id: (appointment.patientId as any)?._id || appointment.patientId, userId });
      const hasFamilyRelationship = await FamilyRelationship.exists({
        userId,
        patientId: (appointment.patientId as any)?._id || appointment.patientId,
        status: "active",
      });
      if (!isBookingOwner && !ownsPatient && !hasFamilyRelationship) {
        return reply.code(403).send(errorResponse("Forbidden: You can only check in for your own or linked family appointment"));
      }
    }

    if (["completed", "cancelled", "no-show"].includes(appointment.status)) {
      return reply.code(409).send(errorResponse(`Cannot check in for an appointment that is already ${appointment.status}`));
    }

    if (appointment.status === "checked-in" || appointment.status === "in-consultation") {
      return reply.code(200).send(successResponse(appointment, `Patient is already ${appointment.status}`));
    }

    const checkedInAppointment = await Appointment.findOneAndUpdate(
      { _id: appointment._id, status: { $in: ["pending", "confirmed"] } },
      { $set: { status: "checked-in" } },
      { returnDocument: "after" },
    );
    if (!checkedInAppointment) {
      const latestAppointment = await Appointment.findById(appointment._id);
      if (latestAppointment && ["checked-in", "in-consultation"].includes(latestAppointment.status)) {
        return reply.code(200).send(successResponse(latestAppointment, `Patient is already ${latestAppointment.status}`));
      }
      return reply.code(409).send(errorResponse("Appointment was changed by another request. Refresh and try again."));
    }
    appointment = checkedInAppointment;

    const { eventBus } = await import("../events/eventBus.ts");
    const { EVENT_TYPES } = await import("../events/types.ts");

    if (patientUserId) {
      await eventBus.publishDurable({
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

    broadcastQueueUpdate(appointment.clinicId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        status: "checked-in",
        clinicId: appointment.clinicId.toString(),
      },
      timestamp: new Date().toISOString(),
    });

    return reply.code(200).send(successResponse(appointment, `Checked in successfully! Token #${appointment.tokenNumber}`));
  } catch (err) {
    console.error("checkInAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * Autonomous Queue Pacing Loop (P2):
 * Dispatches live "Turn Approaching" WhatsApp/SMS notifications to the upcoming
 * 1st waiting patient (peopleAhead = 1) and 2nd waiting patient (peopleAhead = 2)
 * for the specified clinic and doctor.
 * Employs turnApproachingNotifiedAt guard to prevent duplicate notifications.
 */
export async function triggerTurnApproachingPacing(clinicId: any, doctorId: any): Promise<void> {
  try {
    if (!clinicId || !doctorId) return;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const waitingAppts = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed"] },
    });

    if (!waitingAppts || waitingAppts.length === 0) return;

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

    const { sendTurnApproachingNotification } = await import("../utilities/notifications.ts");

    // Upcoming Patient #1 (Immediate Next Up: 1 ahead)
    if (waitingAppts[0] && !(waitingAppts[0] as any).turnApproachingNotifiedAt) {
      await sendTurnApproachingNotification(waitingAppts[0]._id, 1);
      await Appointment.updateOne(
        { _id: waitingAppts[0]._id },
        { $set: { turnApproachingNotifiedAt: new Date() } }
      );
    }

    // Upcoming Patient #2 (Standby Outside: 2 ahead)
    if (waitingAppts[1] && !(waitingAppts[1] as any).turnApproachingNotifiedAt) {
      await sendTurnApproachingNotification(waitingAppts[1]._id, 2);
      await Appointment.updateOne(
        { _id: waitingAppts[1]._id },
        { $set: { turnApproachingNotifiedAt: new Date() } }
      );
    }
  } catch (err) {
    console.error("triggerTurnApproachingPacing error:", err);
  }
}

export async function callNextPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const { clinicId, doctorId, completePrevious = false } = (req.body || {}) as {
      clinicId?: string;
      doctorId?: string;
      completePrevious?: boolean;
    };

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

    // 1. Single Active Consultation Guard: Prevent orphan/concurrent in-consultation appointments
    const activeConsultation = await Appointment.findOne({
      doctorId: targetDoctorId,
      status: "in-consultation",
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    }).populate({
      path: "patientId",
      select: "name",
    });

    if (activeConsultation) {
      if (!completePrevious) {
        return reply.code(409).send(
          errorResponse(
            `Doctor already has an active consultation with ${(activeConsultation.patientId as any)?.name || "a patient"} (Token #${activeConsultation.tokenNumber}). Complete the current consultation first, or pass completePrevious: true.`,
            "ACTIVE_CONSULTATION_IN_PROGRESS"
          )
        );
      }

      // Explicitly release the database consultation lock before advancing.
      await Appointment.updateOne(
        { _id: activeConsultation._id, status: "in-consultation" },
        {
          $set: { status: "completed" },
          $unset: { activeConsultationDoctorDayKey: 1 },
        },
      );

      const { Encounter } = await import("../models/Encounter.ts");
      await Encounter.updateOne(
        { appointmentId: activeConsultation._id, status: "in_progress" },
        { status: "completed", endedAt: new Date() }
      );

      await AuditLog.create({
        userId,
        action: "CONSULTATION_AUTO_COMPLETED_ON_NEXT",
        targetId: activeConsultation._id,
        targetModel: "Appointment",
        category: "ADMIN",
        details: {
          tokenNumber: activeConsultation.tokenNumber,
          doctorId: targetDoctorId,
        },
      });
    }

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

    const nextCandidate = waitingAppts[0];

    // Concurrency Lock: Atomic transition from waiting status to in-consultation
    const nextAppt = await Appointment.findOneAndUpdate(
      {
        _id: nextCandidate._id,
        status: { $in: ["checked-in", "confirmed", "pending"] },
      },
      {
        $set: {
          status: "in-consultation",
          queuePosition: 0,
          activeConsultationDoctorDayKey: getActiveConsultationDoctorDayKey(targetDoctorId, nextCandidate.appointmentTime),
        },
      },
      { returnDocument: "after" }
    ).populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    }).populate("clinicId", "name city");

    if (!nextAppt) {
      return reply.code(409).send(errorResponse("Patient was already called or modified by another session. Please refresh queue.", "CONCURRENT_QUEUE_CALL"));
    }

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
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.PATIENT_CALL_NEXT,
        category: "patient",
        targetUserId: patientUserId,
        title: "Called for Consultation 🩺",
        message: `Please proceed to consultation room. Token #${nextAppt.tokenNumber}`,
        severity: "info",
        actionUrl: "/dashboard/appointments"
      });
    }

    // Instant WhatsApp Cabin Doorway Summon Notification to Patient Phone
    const patientPhone = (nextAppt.patientId as any)?.phone || (nextAppt.patientId as any)?.userId?.phone;
    if (patientPhone) {
      try {
        const { sendDoorwaySummonNotification } = await import("../utilities/notifications.ts");
        await sendDoorwaySummonNotification({
          appointmentId: nextAppt._id.toString(),
          phone: patientPhone,
        });
      } catch (waErr) {
        // Non-blocking
      }
    }

    await AuditLog.create({
      userId,
      action: "PATIENT_CALL_NEXT",
      targetId: nextAppt._id,
      targetModel: "Appointment",
      details: { tokenNumber: nextAppt.tokenNumber, status: "in-consultation" }
    });

    const targetClinicId = (nextAppt.clinicId as any)?._id?.toString() || nextAppt.clinicId?.toString();
    if (targetClinicId) {
      broadcastQueueUpdate(targetClinicId, {
        type: "QUEUE_CALL_NEXT",
        data: {
          appointmentId: nextAppt._id.toString(),
          tokenNumber: nextAppt.tokenNumber,
          doctorId: targetDoctorId,
          clinicId: targetClinicId,
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Autonomous Queue Pacing (P2): Dispatch turn approaching notifications to next in line
    triggerTurnApproachingPacing(nextAppt.clinicId, targetDoctorId).catch((err) =>
      console.error("Background turn approaching pacing error on call next:", err)
    );

    return reply.code(200).send(successResponse(nextAppt, `Calling Token #${nextAppt.tokenNumber}`));
  } catch (err) {
    console.error("callNextPatient error:", err);
    if (isActiveConsultationLockConflict(err)) {
      return reply.code(409).send(errorResponse("Doctor already has an active consultation. Refresh the queue before calling the next patient.", "ACTIVE_CONSULTATION_IN_PROGRESS"));
    }
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function bumpQueuePatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { bumpPositions = 2 } = (req.body || {}) as { bumpPositions?: number };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appointment.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const targetDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

    const activeWaiting = await Appointment.find({
      clinicId: appointment.clinicId,
      doctorId: appointment.doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] },
    }).sort({ queuePosition: 1, tokenNumber: 1 });

    const currentIndex = activeWaiting.findIndex((a) => a._id.toString() === appointment._id.toString());
    if (currentIndex === -1) {
      return reply.code(400).send(errorResponse("Patient is not in an active waiting state"));
    }

    const targetIndex = Math.min(activeWaiting.length - 1, currentIndex + bumpPositions);
    if (targetIndex !== currentIndex) {
      const [movedItem] = activeWaiting.splice(currentIndex, 1);
      activeWaiting.splice(targetIndex, 0, movedItem);

      for (let i = 0; i < activeWaiting.length; i++) {
        activeWaiting[i].queuePosition = i + 1;
        await activeWaiting[i].save();
      }
    }

    appointment.notes = appointment.notes
      ? `${appointment.notes} | [Late arrival: bumped back ${bumpPositions} positions]`
      : `[Late arrival: bumped back ${bumpPositions} positions]`;
    await appointment.save();

    await AuditLog.create({
      userId: req.user!.id,
      action: "QUEUE_PATIENT_BUMP_BACK",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { previousIndex: currentIndex, newIndex: targetIndex, bumpPositions },
    });

    broadcastQueueUpdate(appointment.clinicId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: appointment.clinicId.toString(),
        doctorId: appointment.doctorId.toString(),
        bumpedAppointmentId: appointment._id.toString(),
      },
      message: `Patient Token #${appointment.tokenNumber} bumped back due to late arrival`,
      timestamp: new Date().toISOString(),
    });

    // Autonomous Queue Pacing (P2): Dispatch turn approaching notifications if queue order shifted
    triggerTurnApproachingPacing(appointment.clinicId, appointment.doctorId).catch((err) =>
      console.error("Background turn approaching pacing error on bump:", err)
    );

    return reply.code(200).send(
      successResponse(
        { appointment, newPosition: targetIndex + 1 },
        `Patient moved ${bumpPositions} positions back in queue`
      )
    );
  } catch (err) {
    console.error("bumpQueuePatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function triggerAutoNoShowDetection(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date } = (req.body || {}) as { clinicId: string; doctorId?: string; date?: string };
    if (!clinicId) {
      return reply.code(400).send(errorResponse("clinicId is required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const targetDate = date ? new Date(date) : new Date();
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

    const docIds: string[] = doctorId ? [doctorId] : [];
    if (!doctorId) {
      const assignments = await DoctorAssignment.find({ clinicId, isActive: true }).select("doctorId");
      docIds.push(...assignments.map((a) => a.doctorId.toString()));
    }

    let totalNoShows = 0;
    for (const dId of docIds) {
      totalNoShows += await autoDetectNoShows(clinicId, dId, startOfDay, endOfDay);
    }

    return reply.code(200).send(
      successResponse({ detectedNoShows: totalNoShows }, `${totalNoShows} un-arrived appointments marked as no-show`)
    );
  } catch (err) {
    console.error("triggerAutoNoShowDetection error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function parkQueuePatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { reason } = (req.body || {}) as { reason?: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appointment.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    if (appointment.status === "in-consultation") {
      return reply.code(400).send(errorResponse("Cannot park a patient currently in active consultation"));
    }

    if (appointment.status !== "checked-in" && appointment.status !== "confirmed" && appointment.status !== "pending") {
      return reply.code(400).send(errorResponse("Only waiting or checked-in patients can be placed in standby"));
    }

    const targetDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

    const oldPosition = appointment.queuePosition;
    appointment.status = "standby";
    appointment.parkedAt = new Date();
    appointment.parkedReason = reason || "Stepped out / did not respond to summon";
    appointment.queuePosition = undefined;
    appointment.notes = appointment.notes
      ? `${appointment.notes} | [Standby: ${appointment.parkedReason}]`
      : `[Standby: ${appointment.parkedReason}]`;
    await appointment.save();

    // Re-index remaining active waiting patients for this doctor today
    const remainingWaiting = await Appointment.find({
      clinicId: appointment.clinicId,
      doctorId: appointment.doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] },
    }).sort({ queuePosition: 1, tokenNumber: 1 });

    for (let i = 0; i < remainingWaiting.length; i++) {
      remainingWaiting[i].queuePosition = i + 1;
      await remainingWaiting[i].save();
    }

    // Audit Log
    await AuditLog.create({
      userId: req.user!.id,
      organizationId: appointment.organizationId,
      action: "QUEUE_PATIENT_PARKED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        previousPosition: oldPosition,
        parkedReason: appointment.parkedReason,
        reason: appointment.parkedReason,
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
      },
    });

    const clinicIdStr = appointment.clinicId.toString();
    broadcastQueueUpdate(clinicIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: clinicIdStr,
        doctorId: appointment.doctorId.toString(),
        parkedAppointmentId: appointment._id.toString(),
      },
      message: `Token #${appointment.tokenNumber} moved to standby (${appointment.parkedReason})`,
      timestamp: new Date().toISOString(),
    });

    // Autonomous Queue Pacing (P2): Update pacing for remaining waiting queue
    triggerTurnApproachingPacing(appointment.clinicId, appointment.doctorId).catch((err) =>
      console.error("Background turn approaching pacing error on park:", err)
    );

    return reply.code(200).send(successResponse(appointment, `Patient Token #${appointment.tokenNumber} moved to standby`));
  } catch (err) {
    console.error("parkQueuePatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function resumeQueuePatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appointment.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    if (appointment.status !== "standby") {
      return reply.code(400).send(errorResponse("Only patients in standby can be resumed to queue"));
    }

    const targetDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

    // Shift all existing waiting patients down by 1 so this resumed patient becomes queuePosition = 1 (Next Up!)
    const existingWaiting = await Appointment.find({
      clinicId: appointment.clinicId,
      doctorId: appointment.doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] },
      _id: { $ne: appointment._id },
    }).sort({ queuePosition: 1, tokenNumber: 1 });

    for (let i = 0; i < existingWaiting.length; i++) {
      existingWaiting[i].queuePosition = i + 2;
      await existingWaiting[i].save();
    }

    appointment.status = "checked-in";
    appointment.queuePosition = 1;
    appointment.notes = appointment.notes
      ? `${appointment.notes} | [Resumed from Standby - Next Up]`
      : `[Resumed from Standby - Next Up]`;
    await appointment.save();

    await AuditLog.create({
      userId: req.user!.id,
      organizationId: appointment.organizationId,
      action: "QUEUE_PATIENT_RESUMED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        assignedPosition: 1,
        restoredPosition: 1,
        isPriorityNextUp: true,
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
      },
    });

    const clinicIdStr = appointment.clinicId.toString();
    broadcastQueueUpdate(clinicIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: clinicIdStr,
        doctorId: appointment.doctorId.toString(),
        resumedAppointmentId: appointment._id.toString(),
      },
      message: `Token #${appointment.tokenNumber} resumed from standby as Next Up!`,
      timestamp: new Date().toISOString(),
    });

    // Autonomous Queue Pacing (P2): Dispatch turn approaching notifications for newly resumed queue order
    triggerTurnApproachingPacing(appointment.clinicId, appointment.doctorId).catch((err) =>
      console.error("Background turn approaching pacing error on resume:", err)
    );

    return reply.code(200).send(successResponse(appointment, `Patient Token #${appointment.tokenNumber} resumed as Next Up`));
  } catch (err) {
    console.error("resumeQueuePatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getQueueDelayStatus(req: FastifyRequest, reply: FastifyReply) {
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

    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
    const defaultDuration = assignment?.appointmentDuration || 15;

    const { duration } = await getAdaptiveConsultationDuration(
      clinicId,
      doctorId,
      startOfDay,
      endOfDay,
      defaultDuration
    );

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

    const inConsultationAppt = appointments.find((a: any) => a.status === "in-consultation");
    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter } = await import("../models/Encounter.ts");
      const activeEncounter = await Encounter.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1000));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }

    let waitingAheadCount = 0;
    const now = new Date();
    const delayedPatients: any[] = [];

    for (const appt of appointments) {
      if (appt.status === "pending" || appt.status === "confirmed" || appt.status === "checked-in") {
        const estimatedWaitMinutes = inConsultationRemainingMinutes + (waitingAheadCount * duration);
        const projectedStartTime = new Date(now.getTime() + estimatedWaitMinutes * 60 * 1000);
        const scheduledTime = new Date(appt.appointmentTime);
        const delayMinutes = Math.round((projectedStartTime.getTime() - scheduledTime.getTime()) / (60 * 1000));

        if ((appt.status === "pending" || appt.status === "confirmed") && delayMinutes >= 20) {
          const patientUser = (appt.patientId as any)?.userId;
          const phone = patientUser?.phone || (appt.patientId as any)?.phone;
          const patientName = patientUser?.name || (appt.patientId as any)?.name || "Patient";
          delayedPatients.push({
            appointmentId: appt._id.toString(),
            tokenNumber: appt.tokenNumber,
            patientName,
            phone,
            scheduledTime: scheduledTime.toISOString(),
            projectedStartTime: projectedStartTime.toISOString(),
            delayMinutes,
            revisedArrivalTime: projectedStartTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            delayNotifiedAt: appt.delayNotifiedAt,
            lastNotifiedDelayMinutes: appt.lastNotifiedDelayMinutes,
          });
        }
        waitingAheadCount++;
      }
    }

    const maxDelayMinutes = delayedPatients.length > 0 ? Math.max(...delayedPatients.map(p => p.delayMinutes)) : 0;

    return reply.code(200).send(successResponse({
      isDelayed: delayedPatients.length > 0,
      maxDelayMinutes,
      affectedCount: delayedPatients.length,
      delayedPatients,
    }));
  } catch (err) {
    console.error("getQueueDelayStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function triggerQueueDelayAlerts(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date, delayThresholdMinutes = 20 } = (req.body || {}) as {
      clinicId: string;
      doctorId: string;
      date?: string;
      delayThresholdMinutes?: number;
    };

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

    const [assignment, clinic, doctor] = await Promise.all([
      DoctorAssignment.findOne({ doctorId, clinicId, isActive: true }),
      Clinic.findById(clinicId).select("name organizationId"),
      User.findById(doctorId).select("name"),
    ]);

    const defaultDuration = assignment?.appointmentDuration || 15;
    const { duration } = await getAdaptiveConsultationDuration(clinicId, doctorId, startOfDay, endOfDay, defaultDuration);

    const appointments = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    })
    .populate({
      path: "patientId",
      populate: { path: "userId", select: "name email phone" }
    })
    .sort({ queuePosition: 1, tokenNumber: 1 });

    const inConsultationAppt = appointments.find((a: any) => a.status === "in-consultation");
    let inConsultationRemainingMinutes = 0;
    if (inConsultationAppt) {
      const { Encounter } = await import("../models/Encounter.ts");
      const activeEncounter = await Encounter.findOne({ appointmentId: inConsultationAppt._id, status: "in_progress" }).lean();
      if (activeEncounter?.startedAt) {
        const elapsedMinutes = Math.floor((Date.now() - new Date(activeEncounter.startedAt).getTime()) / (60 * 1000));
        inConsultationRemainingMinutes = Math.max(1, duration - elapsedMinutes);
      } else {
        inConsultationRemainingMinutes = duration;
      }
    }

    let waitingAheadCount = 0;
    const now = new Date();
    let notifiedCount = 0;
    const debounceMs = 45 * 60 * 1000; // 45 minute debounce

    for (const appt of appointments) {
      if (appt.status === "pending" || appt.status === "confirmed" || appt.status === "checked-in") {
        const estimatedWaitMinutes = inConsultationRemainingMinutes + (waitingAheadCount * duration);
        const projectedStartTime = new Date(now.getTime() + estimatedWaitMinutes * 60 * 1000);
        const scheduledTime = new Date(appt.appointmentTime);
        const delayMinutes = Math.round((projectedStartTime.getTime() - scheduledTime.getTime()) / (60 * 1000));

        if ((appt.status === "pending" || appt.status === "confirmed") && delayMinutes >= delayThresholdMinutes) {
          const patientUser = (appt.patientId as any)?.userId;
          const phone = patientUser?.phone || (appt.patientId as any)?.phone;
          const patientName = patientUser?.name || (appt.patientId as any)?.name || "Patient";
          const isDebounced = appt.delayNotifiedAt && (now.getTime() - new Date(appt.delayNotifiedAt).getTime()) < debounceMs;

          if (phone && !isDebounced) {
            const revisedArrivalTime = projectedStartTime.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const orgId = clinic?.organizationId?.toString() || appt.organizationId?.toString() || "";

            try {
              const { url: trackerUrl } = await issueAppointmentTrackerLink(appt as any);
              await SmsWhatsAppService.sendQueueDelayAlert(
                appt._id.toString(),
                orgId,
                phone,
                {
                  patientName,
                  doctorName: doctor?.name || "Doctor",
                  clinicName: clinic?.name || "Clinic",
                  delayMinutes,
                  revisedArrivalTime,
                  trackerUrl,
                }
              );

              appt.delayNotifiedAt = now;
              appt.lastNotifiedDelayMinutes = delayMinutes;
              await appt.save();
              notifiedCount++;
            } catch (notifyErr) {
              console.error(`[QueueDelay] Failed to notify appointment ${appt._id}:`, notifyErr);
            }
          }
        }
        waitingAheadCount++;
      }
    }

    return reply.code(200).send(successResponse({ notifiedCount }, `Dispatched delay alerts to ${notifiedCount} patient(s)`));
  } catch (err) {
    console.error("triggerQueueDelayAlerts error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function sendPatientForInvestigation(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { notes, testIds, testNames } = (req.body as { notes?: string; testIds?: string[]; testNames?: string[] }) || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appointment.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    // Only allow sending for investigation if currently in-consultation or checked-in
    if (!["in-consultation", "checked-in"].includes(appointment.status)) {
      return reply.code(400).send(errorResponse(`Cannot send for investigation: status is '${appointment.status}', expected 'in-consultation' or 'checked-in'`));
    }

    const user = (req as any).user;
    const orgId = appointment.organizationId || (await getRequestOrganizationId(req));

    // Resolve or create Encounter for this clinical session
    const { Encounter } = await import("../models/Encounter.ts");
    const { LabOrder } = await import("../models/LabOrder.ts");
    const { LabTest } = await import("../models/LabTest.ts");

    let encounter = await Encounter.findOne({ appointmentId: appointment._id, status: { $ne: "cancelled" } });
    if (!encounter) {
      encounter = await Encounter.create({
        organizationId: orgId,
        clinicId: appointment.clinicId,
        appointmentId: appointment._id,
        patientId: appointment.patientId,
        doctorId: appointment.doctorId,
        encounterType: appointment.appointmentType === "online" ? "telehealth" : "opd",
        status: "in_progress",
        startedAt: appointment.appointmentTime || new Date(),
      });
    }

    // Resolve Lab Tests to order
    const resolvedTestDocs: any[] = [];
    if (Array.isArray(testIds) && testIds.length > 0) {
      for (const tId of testIds) {
        if (mongoose.Types.ObjectId.isValid(tId)) {
          const tDoc = await LabTest.findById(tId);
          if (tDoc) resolvedTestDocs.push(tDoc);
        }
      }
    }

    const namesToResolve = Array.isArray(testNames) && testNames.length > 0
      ? testNames
      : (notes ? notes.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean) : []);

    for (const rawName of namesToResolve) {
      if (resolvedTestDocs.some((d) => d.name.toLowerCase() === rawName.toLowerCase())) continue;

      let found = await LabTest.findOne({
        clinicId: appointment.clinicId,
        name: { $regex: new RegExp(`^${rawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") },
      });
      if (!found) {
        const testCode = rawName.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 10) || "LAB";
        found = await LabTest.create({
          clinicId: appointment.clinicId,
          organizationId: orgId,
          name: rawName,
          code: `${testCode}_${Math.floor(Math.random() * 1000)}`,
          department: "Biochemistry",
          sampleType: "Blood",
          price: 150,
          normalRange: "Standard Diagnostic Reference Range",
        });
      }
      resolvedTestDocs.push(found);
    }

    if (resolvedTestDocs.length === 0) {
      let defaultTest = await LabTest.findOne({ clinicId: appointment.clinicId, name: "General Diagnostic Panel" });
      if (!defaultTest) {
        defaultTest = await LabTest.create({
          clinicId: appointment.clinicId,
          organizationId: orgId,
          name: "General Diagnostic Panel",
          code: "GEN_DIAG",
          department: "General Pathology",
          sampleType: "Blood/Urine",
          price: 250,
          normalRange: "Normal",
        });
      }
      resolvedTestDocs.push(defaultTest);
    }

    // Atomically create LabOrder records in the clinic's Laboratory Worklist
    const createdOrders: any[] = [];
    const orderedByUserId = user?._id || user?.id || appointment.doctorId;
    for (const t of resolvedTestDocs) {
      const order = await LabOrder.create({
        organizationId: orgId,
        clinicId: appointment.clinicId,
        encounterId: encounter._id,
        appointmentId: appointment._id,
        patientId: appointment.patientId,
        testId: t._id,
        orderedBy: orderedByUserId,
        doctorId: appointment.doctorId,
        priority: "urgent",
        clinicalReason: notes || `OPD Diagnostic: ${t.name}`,
        status: "ordered",
      });
      createdOrders.push(order);
    }

    appointment.status = "standby";
    appointment.parkedAt = new Date();
    appointment.parkedReason = "Diagnostic Lab / Investigation";
    appointment.consultationPhase = "initial_pending_investigation";
    appointment.investigationSentAt = new Date();
    if (notes) {
      appointment.investigationNotes = notes;
    }
    appointment.patientReturned = false;
    appointment.patientReturnedAt = undefined;

    // Initialize investigationResults on Appointment with pending status
    (appointment as any).investigationResults = resolvedTestDocs.map((t, idx) => ({
      testId: t._id,
      testName: t.name,
      value: "Pending Sample / Analysis",
      unit: "",
      referenceRange: t.normalRange || "Standard Reference",
      isAbnormal: false,
      resultNotes: "Ordered during OPD consultation",
      resultedAt: new Date(),
      labOrderId: createdOrders[idx]?._id,
    }));

    await appointment.save();

    // Audit log
    await AuditLog.create({
      organizationId: orgId,
      userId: user?._id || user?.id,
      category: "CLINICAL_WRITE",
      action: "QUEUE_PATIENT_SENT_FOR_INVESTIGATION",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
        orderCount: createdOrders.length,
        testNames: resolvedTestDocs.map((t) => t.name),
        investigationNotes: notes || "Diagnostic tests ordered",
      },
    });

    const clinicIdStr = appointment.clinicId.toString();
    broadcastQueueUpdate(clinicIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: clinicIdStr,
        doctorId: appointment.doctorId.toString(),
        appointmentId: appointment._id.toString(),
        status: "standby",
        consultationPhase: "initial_pending_investigation",
      },
      message: `Token #${appointment.tokenNumber} sent for diagnostic lab tests. Room available for next patient.`,
      timestamp: new Date().toISOString(),
    });

    broadcastQueueUpdate(clinicIdStr, {
      type: "LAB_ORDER_PLACED",
      data: {
        clinicId: clinicIdStr,
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        orderCount: createdOrders.length,
        testNames: resolvedTestDocs.map((t) => t.name),
      },
      message: `${createdOrders.length} diagnostic test order(s) placed for Token #${appointment.tokenNumber}`,
      timestamp: new Date().toISOString(),
    });

    // Proactively notify patient via WhatsApp about ordered lab tests
    try {
      let patientPhone = "";
      if ((appointment.patientId as any)?.phone) {
        patientPhone = (appointment.patientId as any).phone;
      } else if ((appointment.patientId as any)?.userId?.phone) {
        patientPhone = (appointment.patientId as any).userId.phone;
      } else if (appointment.patientId) {
        const { Patient } = await import("../models/Patient.ts");
        const pDoc = await Patient.findById(appointment.patientId).populate("userId", "phone").lean();
        patientPhone = (pDoc as any)?.phone || (pDoc as any)?.userId?.phone || "";
      }

      if (patientPhone) {
        const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
        const { url: trackingUrl } = await issueAppointmentTrackerLink(appointment as any);
        await sendSmsWhatsAppNotification({
          organizationId: orgId?.toString(),
          appointmentId: appointment._id.toString(),
          phone: patientPhone,
          channel: "whatsapp",
          templateId: "QUEUE_UPDATE",
          variables: {
            tokenNumber: String(appointment.tokenNumber),
            peopleAhead: "0",
            doctorName: "Laboratory Counter",
            trackingUrl,
          },
          idempotencyKey: `lab_req_${appointment._id}_${Date.now()}`,
        }).catch((err) => console.warn("Patient lab order WhatsApp notification notice:", err));
      }
    } catch (notifErr) {
      console.warn("Lab order patient notification warning:", notifErr);
    }

    return reply.code(200).send(
      successResponse(appointment, `Patient Token #${appointment.tokenNumber} sent for diagnostic tests (${createdOrders.length} orders created). Room unblocked.`)
    );
  } catch (err) {
    console.error("sendPatientForInvestigation error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function resumeForReportReview(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appointment.clinicId.toString());
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    if (appointment.status !== "standby") {
      return reply.code(400).send(errorResponse(`Cannot resume for report review: status is '${appointment.status}', expected 'standby'`));
    }

    // Shift all other waiting/checked-in queuePositions back by 1
    const today = new Date(appointment.appointmentTime);
    const startOfDay = new Date(today);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(today);
    endOfDay.setHours(23, 59, 59, 999);

    await Appointment.updateMany(
      {
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
        _id: { $ne: appointment._id },
        status: { $in: ["checked-in", "confirmed", "pending"] },
      },
      { $inc: { queuePosition: 1 } }
    );

    appointment.status = "checked-in";
    appointment.queuePosition = 1; // Prioritized as Next Up!
    appointment.consultationPhase = "report_review";
    appointment.reasonForVisit = "report_review";
    appointment.parkedAt = undefined;
    appointment.parkedReason = undefined;
    appointment.patientReturned = true;
    appointment.patientReturnedAt = new Date();
    await appointment.save();

    // Audit log
    const user = (req as any).user;
    await AuditLog.create({
      organizationId: appointment.organizationId || (await getRequestOrganizationId(req)),
      userId: user?._id || user?.id,
      category: "CLINICAL_WRITE",
      action: "QUEUE_PATIENT_RESUMED_FOR_REPORT_REVIEW",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        assignedPosition: 1,
        consultationPhase: "report_review",
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
      },
    });

    const clinicIdStr = appointment.clinicId.toString();

    // Query doctor & cabin details for TV lounge announcement & audio chime
    const { Doctor } = await import("../models/Doctor.ts");
    const { User } = await import("../models/User.ts");
    const docUser = await User.findById(appointment.doctorId).select("name").lean();
    const docProfile = await Doctor.findOne({ userId: appointment.doctorId }).select("cabinNumber specialization").lean();
    const cabinNum = (docProfile as any)?.cabinNumber || "Doctor's Cabin";
    const docName = docUser?.name ? (docUser.name.startsWith("Dr.") ? docUser.name : `Dr. ${docUser.name}`) : "Doctor";

    broadcastQueueUpdate(clinicIdStr, {
      type: "PATIENT_RECALLED_TO_CABIN",
      data: {
        clinicId: clinicIdStr,
        doctorId: appointment.doctorId.toString(),
        doctorName: docName,
        cabinNumber: cabinNum,
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        consultationPhase: "report_review",
        audioAnnouncement: {
          en: `Token number ${appointment.tokenNumber}, please proceed to ${cabinNum}, ${docName} for report review.`,
          hi: `टोकन नंबर ${appointment.tokenNumber}, कृपया रिपोर्ट समीक्षा के लिए ${cabinNum}, ${docName} के पास जाएं।`,
        },
      },
      message: `Token #${appointment.tokenNumber} recalled to ${cabinNum} for Report Review!`,
      timestamp: new Date().toISOString(),
    });

    broadcastQueueUpdate(clinicIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: clinicIdStr,
        doctorId: appointment.doctorId.toString(),
        resumedAppointmentId: appointment._id.toString(),
        consultationPhase: "report_review",
      },
      message: `Token #${appointment.tokenNumber} resumed for Report Review as Next Up!`,
      timestamp: new Date().toISOString(),
    });

    return reply.code(200).send(
      successResponse(appointment, `Patient Token #${appointment.tokenNumber} recalled to ${cabinNum} for Report Review as Next Up`)
    );
  } catch (err) {
    console.error("resumeForReportReview error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function startOpdSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, date } = (req.body as { clinicId: string; doctorId: string; date?: string }) || {};

    if (!clinicId || !doctorId) {
      return reply.code(400).send(errorResponse("clinicId and doctorId are required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const { OpdSession } = await import("../models/OpdSession.ts");
    const user = (req as any).user;
    const orgId = await getRequestOrganizationId(req);

    const now = new Date();
    const dateStr = date ? date.slice(0, 10) : now.toISOString().slice(0, 10);

    const session = await OpdSession.findOneAndUpdate(
      { clinicId, doctorId, date: dateStr },
      {
        $set: {
          organizationId: orgId,
          status: "active",
          startedAt: now,
          startedBy: user?._id || user?.id,
        },
        $unset: { endedAt: 1, endedBy: 1 },
      },
      { upsert: true, returnDocument: "after" }
    );

    // Audit log
    await AuditLog.create({
      organizationId: orgId,
      userId: user?._id || user?.id,
      category: "ADMIN",
      action: "OPD_SESSION_STARTED",
      targetId: session._id,
      targetModel: "OpdSession",
      details: { clinicId, doctorId, date: dateStr, startedAt: now },
    });

    broadcastQueueUpdate(clinicId.toString(), {
      type: "QUEUE_UPDATED",
      data: { clinicId, doctorId, opdSession: session },
      message: `Doctor OPD session started for today.`,
      timestamp: now.toISOString(),
    });

    return reply.code(200).send(successResponse(session, "OPD session started successfully"));
  } catch (err) {
    console.error("startOpdSession error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function toggleDoctorBreak(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, isOnBreak, breakReason, breakExpectedMinutes, date } =
      (req.body as {
        clinicId: string;
        doctorId: string;
        isOnBreak: boolean;
        breakReason?: string;
        breakExpectedMinutes?: number;
        date?: string;
      }) || {};

    if (!clinicId || !doctorId) {
      return reply.code(400).send(errorResponse("clinicId and doctorId are required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const { OpdSession } = await import("../models/OpdSession.ts");
    const user = (req as any).user;
    const orgId = await getRequestOrganizationId(req);

    const now = new Date();
    const dateStr = date ? date.slice(0, 10) : now.toISOString().slice(0, 10);

    const updateFields: any = {
      organizationId: orgId,
      isOnBreak: Boolean(isOnBreak),
    };

    if (isOnBreak) {
      updateFields.status = "active";
      updateFields.breakReason = breakReason?.trim() || "Short Intermission";
      updateFields.breakStartedAt = now;
      updateFields.breakExpectedMinutes = Number(breakExpectedMinutes) || 15;
    } else {
      updateFields.breakReason = "";
      updateFields.breakStartedAt = null;
    }

    const session = await OpdSession.findOneAndUpdate(
      { clinicId, doctorId, date: dateStr },
      { $set: updateFields },
      { upsert: true, returnDocument: "after" }
    );

    // Audit log
    await AuditLog.create({
      organizationId: orgId,
      userId: user?._id || user?.id,
      category: "ADMIN",
      action: isOnBreak ? "DOCTOR_BREAK_STARTED" : "DOCTOR_BREAK_ENDED",
      targetId: session._id,
      targetModel: "OpdSession",
      details: {
        clinicId,
        doctorId,
        date: dateStr,
        isOnBreak: session.isOnBreak,
        breakReason: session.breakReason,
        breakExpectedMinutes: session.breakExpectedMinutes,
      },
    });

    broadcastQueueUpdate(clinicId.toString(), {
      type: "QUEUE_UPDATED",
      data: {
        clinicId,
        doctorId,
        opdSession: session,
        doctorBreak: {
          isOnBreak: session.isOnBreak,
          breakReason: session.breakReason,
          breakStartedAt: session.breakStartedAt,
          breakExpectedMinutes: session.breakExpectedMinutes,
        },
      },
      message: isOnBreak
        ? `Doctor is on a short break (${session.breakReason || "Intermission"}).`
        : `Doctor has resumed OPD consultations.`,
      timestamp: now.toISOString(),
    });

    return reply.code(200).send(
      successResponse(session, isOnBreak ? "Doctor break started successfully" : "Doctor break ended successfully")
    );
  } catch (err) {
    console.error("toggleDoctorBreak error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getOpdSessionSummary(req: FastifyRequest, reply: FastifyReply) {
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
    const dateStr = date ? date.slice(0, 10) : new Date().toISOString().slice(0, 10);

    const { OpdSession } = await import("../models/OpdSession.ts");
    const session = await OpdSession.findOne({ clinicId, doctorId, date: dateStr }).lean();

    const appointments = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
    })
    .populate({
      path: "patientId",
      populate: { path: "userId", select: "name phone" },
    })
    .lean();

    const completed = appointments.filter((a) => a.status === "completed");
    const inConsultation = appointments.filter((a) => a.status === "in-consultation");
    const standbyPatients = appointments.filter((a) => a.status === "standby");
    const waitingPatients = appointments.filter((a) => ["checked-in", "confirmed", "pending"].includes(a.status));
    const noShowPatients = appointments.filter((a) => a.status === "no-show");
    const cancelledPatients = appointments.filter((a) => a.status === "cancelled");

    return reply.code(200).send(
      successResponse({
        session: session || { status: "not_started", date: dateStr },
        counts: {
          total: appointments.length,
          completed: completed.length,
          inConsultation: inConsultation.length,
          standby: standbyPatients.length,
          waiting: waitingPatients.length,
          noShow: noShowPatients.length,
          cancelled: cancelledPatients.length,
        },
        standbyList: standbyPatients.map((p) => ({
          id: p._id,
          tokenNumber: p.tokenNumber,
          patientName: (p.patientId as any)?.name || (p.patientId as any)?.userId?.name || "Patient",
          phone: (p.patientId as any)?.userId?.phone || (p.patientId as any)?.phone,
          parkedReason: p.parkedReason,
          parkedAt: p.parkedAt,
          patientReturned: p.patientReturned || false,
        })),
        waitingList: waitingPatients.map((p) => ({
          id: p._id,
          tokenNumber: p.tokenNumber,
          status: p.status,
          patientName: (p.patientId as any)?.name || (p.patientId as any)?.userId?.name || "Patient",
          phone: (p.patientId as any)?.userId?.phone || (p.patientId as any)?.phone,
          appointmentTime: p.appointmentTime,
        })),
      })
    );
  } catch (err) {
    console.error("getOpdSessionSummary error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function endOpdSessionAndReconcile(req: FastifyRequest, reply: FastifyReply) {
  try {
    const {
      clinicId,
      doctorId,
      date,
      standbyAction = "mark_no_show",
      waitingAction = "cancel_refund",
    } = (req.body as {
      clinicId: string;
      doctorId: string;
      date?: string;
      standbyAction?: "mark_no_show" | "cancel_refund";
      waitingAction?: "cancel_refund" | "keep_unresolved";
    }) || {};

    if (!clinicId || !doctorId) {
      return reply.code(400).send(errorResponse("clinicId and doctorId are required"));
    }

    const clinicCheck = await checkClinicAccess(req, clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const dateStr = date ? date.slice(0, 10) : now.toISOString().slice(0, 10);

    const { OpdSession } = await import("../models/OpdSession.ts");
    const { Invoice } = await import("../models/Invoice.ts");
    const user = (req as any).user;
    const orgId = await getRequestOrganizationId(req);

    // 1. Reconcile Standby Patients
    const standbyAppointments = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: "standby",
    });

    let standbyReconciledCount = 0;
    for (const appt of standbyAppointments) {
      if (standbyAction === "mark_no_show") {
        appt.status = "no-show";
        appt.notes = appt.notes
          ? `${appt.notes} | [End of OPD: Patient remained on standby without returning]`
          : `[End of OPD: Patient remained on standby without returning]`;
        await appt.save();
        standbyReconciledCount++;
      } else if (standbyAction === "cancel_refund") {
        appt.status = "cancelled";
        appt.cancellationReason = "End of OPD shift — unresumed standby";
        await appt.save();

        // Update invoice to cancelled/refunded
        await Invoice.updateMany(
          { appointmentId: appt._id, status: { $in: ["paid", "unpaid", "partially_paid"] } as any },
          { $set: { status: "cancelled" as any, notes: "Auto-cancelled: OPD closed with patient on standby" } }
        );
        standbyReconciledCount++;
      }
    }

    // 2. Reconcile Unserved Waiting Patients
    const waitingAppointments = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed", "pending"] },
    });

    let waitingReconciledCount = 0;
    if (waitingAction === "cancel_refund") {
      for (const appt of waitingAppointments) {
        appt.status = "cancelled";
        appt.cancellationReason = "End of OPD shift — patient not called before session close";
        await appt.save();

        // Update invoice
        await Invoice.updateMany(
          { appointmentId: appt._id, status: { $in: ["paid", "unpaid", "partially_paid"] } as any },
          { $set: { status: "cancelled" as any, notes: "Auto-refund: OPD closed before consultation could occur" } }
        );
        waitingReconciledCount++;
      }
    }

    // 3. Mark in-consultation as completed if any remained open
    const inConsultationAppts = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: "in-consultation",
    });

    for (const appt of inConsultationAppts) {
      appt.status = "completed";
      await appt.save();
    }

    // 4. Update OpdSession
    const session = await OpdSession.findOneAndUpdate(
      { clinicId, doctorId, date: dateStr },
      {
        $set: {
          organizationId: orgId,
          status: "ended",
          endedAt: now,
          endedBy: user?._id || user?.id,
          reconciliationSummary: {
            standbyCount: standbyAppointments.length,
            standbyAction,
            waitingCount: waitingAppointments.length,
            waitingAction,
            reconciledAt: now,
          },
        },
      },
      { upsert: true, returnDocument: "after" }
    );

    // 5. Audit Log
    await AuditLog.create({
      organizationId: orgId,
      userId: user?._id || user?.id,
      category: "ADMIN",
      action: "OPD_SESSION_CLOSED_AND_RECONCILED",
      targetId: session._id,
      targetModel: "OpdSession",
      details: {
        clinicId,
        doctorId,
        date: dateStr,
        standbyReconciledCount,
        waitingReconciledCount,
        closedAt: now,
      },
    });

    broadcastQueueUpdate(clinicId.toString(), {
      type: "QUEUE_UPDATED",
      data: { clinicId, doctorId, opdSession: session },
      message: `Doctor OPD session ended and reconciled.`,
      timestamp: now.toISOString(),
    });

    return reply.code(200).send(
      successResponse(
        {
          session,
          standbyReconciledCount,
          waitingReconciledCount,
        },
        `OPD Session ended. Reconciled ${standbyReconciledCount} standby and ${waitingReconciledCount} waiting appointments.`
      )
    );
  } catch (err) {
    console.error("endOpdSessionAndReconcile error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function recordPatientVitals(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appointment.clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const body = (req.body || {}) as {
      bpSystolic?: number;
      bpDiastolic?: number;
      pulse?: number;
      temperature?: number;
      temperatureUnit?: "F" | "C";
      spO2?: number;
      weight?: number;
      height?: number;
      bloodSugar?: number;
      bloodSugarType?: "random" | "fasting" | "post_prandial";
      allergies?: string;
      triageNotes?: string;
    };

    let bmi: number | undefined;
    if (body.weight && body.height && body.height > 0) {
      const heightM = body.height / 100;
      bmi = Number((body.weight / (heightM * heightM)).toFixed(1));
    }

    const user = (req as any).user;
    const now = new Date();

    const parsedAllergies = Array.isArray(body.allergies)
      ? body.allergies.map((a: any) => String(a).trim()).filter(Boolean)
      : typeof body.allergies === "string" && body.allergies.trim()
      ? body.allergies.split(",").map((a: string) => a.trim()).filter(Boolean)
      : undefined;

    const vitalsData = {
      bpSystolic: body.bpSystolic ? Number(body.bpSystolic) : undefined,
      bpDiastolic: body.bpDiastolic ? Number(body.bpDiastolic) : undefined,
      pulse: body.pulse ? Number(body.pulse) : undefined,
      temperature: body.temperature ? Number(body.temperature) : undefined,
      temperatureUnit: body.temperatureUnit || "F",
      spO2: body.spO2 ? Number(body.spO2) : undefined,
      weight: body.weight ? Number(body.weight) : undefined,
      height: body.height ? Number(body.height) : undefined,
      bmi,
      bloodSugar: body.bloodSugar ? Number(body.bloodSugar) : undefined,
      bloodSugarType: body.bloodSugarType || "random",
      allergies: parsedAllergies,
      triageNotes: typeof body.triageNotes === "string" ? body.triageNotes.trim() : undefined,
      recordedAt: now,
      recordedBy: user?._id || user?.id,
      recordedByName: user?.name || "Triage Staff",
    };

    appointment.vitals = vitalsData as any;
    await appointment.save();

    // Create / ensure Encounter exists so standard Observation records can be linked
    try {
      const { Encounter } = await import("../models/Encounter.ts");
      let encounter = await Encounter.findOne({ appointmentId: appointment._id });
      if (!encounter) {
        encounter = await Encounter.create({
          organizationId: (appointment.organizationId as any) || undefined,
          clinicId: appointment.clinicId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: "opd",
          status: "in_progress",
          startedAt: now,
        });
      }

      const { Observation } = await import("../models/Observation.ts");
      const observationsToCreate: any[] = [];

      if (vitalsData.bpSystolic && vitalsData.bpDiastolic) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "BP",
          name: "Blood Pressure",
          value: `${vitalsData.bpSystolic}/${vitalsData.bpDiastolic}`,
          unit: "mmHg",
          referenceRange: "< 120/80",
          recordedAt: now,
        });
      }
      if (vitalsData.pulse) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "HR",
          name: "Heart Rate",
          value: String(vitalsData.pulse),
          unit: "bpm",
          referenceRange: "60-100",
          recordedAt: now,
        });
      }
      if (vitalsData.spO2) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "SPO2",
          name: "Oxygen Saturation",
          value: String(vitalsData.spO2),
          unit: "%",
          referenceRange: ">= 95%",
          recordedAt: now,
        });
      }
      if (vitalsData.temperature) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "TEMP",
          name: "Body Temperature",
          value: String(vitalsData.temperature),
          unit: `°${vitalsData.temperatureUnit}`,
          referenceRange: "97.8 - 99.1 °F",
          recordedAt: now,
        });
      }
      if (vitalsData.weight) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "WEIGHT",
          name: "Body Weight",
          value: String(vitalsData.weight),
          unit: "kg",
          recordedAt: now,
        });
      }
      if (vitalsData.bmi) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "BMI",
          name: "Body Mass Index",
          value: String(vitalsData.bmi),
          unit: "kg/m²",
          referenceRange: "18.5 - 24.9",
          recordedAt: now,
        });
      }
      if (vitalsData.bloodSugar) {
        observationsToCreate.push({
          organizationId: appointment.organizationId,
          clinicId: appointment.clinicId,
          encounterId: encounter._id,
          patientId: appointment.patientId,
          recordedBy: user?._id || user?.id,
          code: "GLUCOSE",
          name: `Blood Glucose (${vitalsData.bloodSugarType})`,
          value: String(vitalsData.bloodSugar),
          unit: "mg/dL",
          referenceRange: vitalsData.bloodSugarType === "fasting" ? "70 - 99" : "< 140",
          recordedAt: now,
        });
      }

      if (observationsToCreate.length > 0) {
        await Observation.insertMany(observationsToCreate);
      }
    } catch (obsErr) {
      console.warn("Observation persistence notice:", obsErr);
    }

    // Audit log
    await AuditLog.create({
      organizationId: appointment.organizationId,
      userId: user?._id || user?.id,
      category: "CLINICAL_WRITE",
      action: "NURSE_VITALS_RECORDED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        vitals: vitalsData,
      },
    });

    const clinicIdStr = appointment.clinicId.toString();
    broadcastQueueUpdate(clinicIdStr, {
      type: "QUEUE_UPDATED",
      data: {
        clinicId: clinicIdStr,
        doctorId: appointment.doctorId.toString(),
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        vitalsUpdated: true,
      },
      message: `Vitals recorded for Token #${appointment.tokenNumber}`,
      timestamp: now.toISOString(),
    });

    return reply.code(200).send(
      successResponse(appointment, `Vitals recorded successfully for Token #${appointment.tokenNumber}`)
    );
  } catch (err) {
    console.error("recordPatientVitals error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function triggerStatEmergency(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicCheck = await checkClinicAccess(req, appointment.clinicId);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const { reason } = (req.body || {}) as { reason?: string };
    const user = (req as any).user;
    const now = new Date();

    const apptDate = new Date(appointment.appointmentTime);
    const startOfDay = new Date(apptDate.getFullYear(), apptDate.getMonth(), apptDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(apptDate.getFullYear(), apptDate.getMonth(), apptDate.getDate(), 23, 59, 59, 999);

    // Shift all active waiting appointments for this doctor back by 1
    await Appointment.updateMany(
      {
        clinicId: appointment.clinicId,
        doctorId: appointment.doctorId,
        appointmentTime: { $gte: startOfDay, $lte: endOfDay },
        _id: { $ne: appointment._id },
        status: { $in: ["checked-in", "confirmed", "pending", "standby"] },
      },
      { $inc: { queuePosition: 1 } }
    );

    appointment.queuePosition = 0; // Top of line / STAT Next
    appointment.isEmergency = true;
    appointment.emergencyTriagedAt = now;
    appointment.status = "checked-in";
    if (reason) {
      appointment.notes = appointment.notes
        ? `${appointment.notes} | 🚨 [EMERGENCY STAT: ${reason}]`
        : `🚨 [EMERGENCY STAT: ${reason}]`;
    }
    await appointment.save();

    // Audit log
    await AuditLog.create({
      organizationId: appointment.organizationId,
      userId: user?._id || user?.id,
      category: "CLINICAL_WRITE",
      action: "EMERGENCY_STAT_PRIORITY_TRIGGERED",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: {
        tokenNumber: appointment.tokenNumber,
        assignedPosition: 0,
        reason: reason || "Acute medical distress in waiting lounge",
      },
    });

    const clinicIdStr = appointment.clinicId.toString();
    const doctorIdStr = appointment.doctorId.toString();

    // High priority emergency event broadcast
    broadcastQueueUpdate(clinicIdStr, {
      type: "QUEUE_EMERGENCY_STAT",
      data: {
        clinicId: clinicIdStr,
        doctorId: doctorIdStr,
        appointmentId: appointment._id.toString(),
        tokenNumber: appointment.tokenNumber,
        queuePosition: 0,
        reason: reason || "Acute emergency triage",
      },
      message: `🚨 STAT EMERGENCY: Token #${appointment.tokenNumber} prioritized for immediate attention!`,
      timestamp: now.toISOString(),
    });

    return reply.code(200).send(
      successResponse(appointment, `Token #${appointment.tokenNumber} marked as STAT Emergency and placed at top of line`)
    );
  } catch (err) {
    console.error("triggerStatEmergency error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

/**
 * Front-Desk 1-Click Resend Tracker Link (P3):
 * Dispatches live queue tracking URL (/track/:id) to patient's registered phone
 * or an alternate attendee number provided at the reception counter via WhatsApp or SMS.
 */
export async function resendQueueTrackerNotification(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { phone: customPhone, channel = "whatsapp" } = (req.body || {}) as {
      phone?: string;
      channel?: "whatsapp" | "sms";
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id)
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicIdStr =
      (appointment.clinicId as any)?._id?.toString() ||
      appointment.clinicId?.toString();
    const clinicCheck = await checkClinicAccess(req, clinicIdStr);
    if (!clinicCheck.allowed) {
      return reply.code(clinicCheck.statusCode).send(errorResponse(clinicCheck.message));
    }

    const patientDoc = appointment.patientId as any;
    const targetPhone =
      (customPhone && customPhone.trim()) ||
      patientDoc?.phone ||
      patientDoc?.userId?.phone;

    if (!targetPhone) {
      return reply.code(400).send(
        errorResponse("No valid phone number found for this patient. Please provide a phone number.")
      );
    }

    const patientName = patientDoc?.name || patientDoc?.userId?.name || "Patient";
    const doctorName = (appointment.doctorId as any)?.name || "Doctor";
    const token = appointment.tokenNumber;
    const { url: trackingUrl } = await issueAppointmentTrackerLink(appointment as any);

    // Calculate live people ahead in today's queue
    const targetDate = new Date(appointment.appointmentTime || Date.now());
    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0);
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);

    const peopleAhead = await Appointment.countDocuments({
      clinicId: appointment.clinicId,
      doctorId: appointment.doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["checked-in", "confirmed"] },
      queuePosition: { $lt: appointment.queuePosition || 999 },
      _id: { $ne: appointment._id },
    });

    const organizationId =
      (appointment.clinicId as any)?.organizationId?.toString() ||
      (appointment as any).organizationId?.toString();

    const { sendSmsWhatsAppNotification } = await import("../services/SmsWhatsAppService.ts");
    const idempotencyKey = `resend_tracker_${appointment._id}_${Date.now()}`;

    const dispatchResult = await sendSmsWhatsAppNotification({
      organizationId,
      appointmentId: appointment._id.toString(),
      phone: targetPhone,
      patientName,
      channel: channel === "sms" ? "sms" : "whatsapp",
      templateId: "QUEUE_UPDATE",
      variables: {
        patientName,
        tokenNumber: String(token),
        peopleAhead: String(peopleAhead),
        doctorName,
        trackingUrl,
      },
      idempotencyKey,
    });

    // In-app alert dispatch if user exists
    const targetUserId = patientDoc?.userId?._id?.toString() || patientDoc?.userId?.toString();
    if (targetUserId) {
      const { eventBus } = await import("../events/eventBus.ts");
      const { EVENT_TYPES } = await import("../events/types.ts");
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.PATIENT_CALL_NEXT,
        category: "patient",
        targetUserId,
        title: `Live Token Tracking Link (#${token})`,
        message: `Your live queue tracker for Dr. ${doctorName} is active. Live position: ${peopleAhead} ahead.`,
        severity: "info",
        actionUrl: trackingUrl,
        metadata: { appointmentId: appointment._id, token, peopleAhead, trackingUrl },
      });
    }

    await AuditLog.create({
      userId: req.user!.id,
      organizationId,
      action: "QUEUE_TRACKER_RESENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      category: "ADMIN",
      details: {
        tokenNumber: token,
        recipientPhone: targetPhone,
        channel,
        peopleAhead,
        trackingUrl,
      },
    });

    return reply.code(200).send(
      successResponse(
        {
          appointmentId: appointment._id,
          tokenNumber: token,
          recipientPhone: targetPhone,
          channel,
          trackingUrl,
          peopleAhead,
          dispatchResult,
        },
        `Live queue tracking link sent to ${targetPhone} via ${channel.toUpperCase()}`
      )
    );
  } catch (err) {
    console.error("resendQueueTrackerNotification error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

import crypto from "node:crypto";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { onlineRefundSource } from "./AppointmentRefundService.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { User } from "../models/User.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { broadcastQueueUpdate, broadcastRealtimeNotification } from "../notifications/websocket.ts";
import { SmsWhatsAppService } from "./SmsWhatsAppService.ts";
import { paymentProvider } from "./payment/PaymentProvider.ts";
import { withClinicalTransaction } from "../utilities/transaction.ts";
import { Counter, getNextAtomicSequence } from "../models/Counter.ts";
import { AppointmentDomainError, validateAppointmentAvailability } from "./AppointmentService.ts";
import { issueAppointmentTrackerLink } from "../utilities/publicTracker.ts";
import { clinicClockMinutes, clinicDateKey, clinicDayRange, clinicLocalTimeToDate, getClinicTimezone } from "../utilities/clinicTime.ts";

function requirePendingDisruption(appointment: any) {
  if (appointment.status !== "disruption_triage" || appointment.triageAction !== "pending") {
    throw new AppointmentDomainError("Appointment is no longer awaiting a disruption response", 409);
  }
}

async function nextDisruptionToken(clinicId: string, doctorId: string, date: string, start: Date, end: Date) {
  const key = `token_${clinicId}_${doctorId}_${date}`;
  const last = await Appointment.findOne({ clinicId, doctorId, appointmentTime: { $gte: start, $lte: end } }).sort({ tokenNumber: -1 }).select("tokenNumber");
  // Adopt legacy/imported tokens without moving the canonical counter backwards.
  await Counter.findOneAndUpdate({ id: key }, { $max: { seq: last?.tokenNumber || 0 } }, { upsert: true });
  return getNextAtomicSequence(key);
}

export interface ProcessDisruptionParams {
  clinicId: string;
  doctorId: string;
  date: string; // YYYY-MM-DD
  status: "available" | "unavailable" | "delayed" | "extended";
  effectiveStartTime?: string | null;
  effectiveEndTime?: string | null;
  reason?: string | null;
  userId: string;
  organizationId?: string | null;
  disruptionId: any;
}

export interface TransferPatientParams {
  appointmentId: string;
  replacementDoctorId: string;
  transferredByUserId: string;
  reason?: string;
}

export interface CancelDisruptionParams {
  appointmentId: string;
  cancelledByUserId: string;
  reason?: string;
  timeoutClaimToken?: string;
}

export interface PriorityRescheduleParams {
  appointmentId: string;
  targetDate: string; // YYYY-MM-DD
  targetDoctorId?: string;
  targetTimeSlot?: string; // e.g. "10:00"
  rescheduledByUserId: string;
  reason?: string;
}

export interface BatchTriageParams {
  action: "transfer" | "cancel" | "reschedule";
  appointmentIds: string[];
  actorUserId: string;
  replacementDoctorId?: string;
  targetDate?: string;
  targetTimeSlot?: string;
  reason?: string;
}

export const disruptionService = {
  /**
   * Orchestrates patient triage when doctor availability is disrupted.
   * - In-consultation patients are preserved and completed normally
   * - Checked-in waiting patients are flagged for immediate reception triage
   * - Confirmed/pending patients receive WhatsApp alert with reschedule/cancel links (60-min window)
   */
  async processDoctorDisruption(params: ProcessDisruptionParams) {
    const {
      clinicId,
      doctorId,
      date,
      status,
      effectiveEndTime,
      reason,
      userId,
      organizationId,
      disruptionId,
    } = params;

    const timezone = await getClinicTimezone(clinicId);
    const { start: startOfDay, end: endOfDay } = clinicDayRange(date, timezone);

    let closingMinutes = 24 * 60;
    if (effectiveEndTime && status !== "unavailable") {
      const [endH, endM] = effectiveEndTime.split(":").map(Number);
      closingMinutes = (endH || 0) * 60 + (endM || 0);
    }

    const appointments = await Appointment.find({
      clinicId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["in-consultation", "checked-in", "confirmed", "pending"] },
    })
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name email")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    let inConsultationPreservedCount = 0;
    let checkedInTriageCount = 0;
    let remoteNotifiedCount = 0;
    const triagedAppointments: any[] = [];

    const now = new Date();
    const responseDeadline = new Date(now.getTime() + 60 * 60 * 1000); // 60-minute window

    for (const appt of appointments) {
      const apptDate = new Date(appt.appointmentTime);
      const apptMinutes = clinicClockMinutes(apptDate, timezone);
      const isAffected = status === "unavailable" || apptMinutes >= closingMinutes;

      if (!isAffected) continue;

      // 1. In-Consultation: PRESERVE, do not interrupt active consultation
      if (appt.status === "in-consultation") {
        inConsultationPreservedCount++;
        continue;
      }

      // 2. Checked-in patients: Physical wait triage (never auto-cancel)
      if (appt.status === "checked-in") {
        const notes = appt.notes
          ? `${appt.notes} | [TRIAGE: Doctor unavailable - awaiting reception action]`
          : `[TRIAGE: Doctor unavailable - awaiting reception action]`;
        // Compare-and-set makes repeated scheduler/API delivery idempotent.
        // Only the request that claims this appointment may emit notifications.
        const triagedAppointment = await Appointment.findOneAndUpdate(
          { _id: appt._id, status: "checked-in" },
          {
            $set: {
              status: "disruption_triage",
              disruptionId,
              disruptedAt: now,
              triageAction: "pending",
              notes,
            },
          },
          { returnDocument: "after" },
        )
          .populate("clinicId", "name phone organizationId")
          .populate("doctorId", "name email")
          .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
        if (!triagedAppointment) continue;

        checkedInTriageCount++;

        const patientDoc = triagedAppointment.patientId as any;
        triagedAppointments.push(triagedAppointment);

        // Publish triage domain event
        await eventBus.publishDurable({
          eventType: EVENT_TYPES.PATIENT_DISRUPTION_TRIAGED,
          category: "patient",
          organizationId: organizationId || undefined,
          targetUserId: patientDoc?.userId?._id?.toString() || patientDoc?.userId?.toString(),
          title: "Doctor Disruption: In-Person Triage Required",
          message: `Patient ${patientDoc?.name || "Patient"} (Token #${appt.tokenNumber}) requires reception reassignment.`,
          severity: "warning",
          priority: "urgent",
          actionUrl: `/dashboard/queue`,
          metadata: {
            appointmentId: triagedAppointment._id.toString(),
            clinicId,
            doctorId,
            tokenNumber: triagedAppointment.tokenNumber,
          },
        });
        continue;
      }

      // 3. Confirmed & Pending patients: Remote triage with 60-minute deadline
      if (appt.status === "confirmed" || appt.status === "pending") {
        const notes = appt.notes
          ? `${appt.notes} | [Doctor unavailable (${status}) - 60min patient action window]`
          : `[Doctor unavailable (${status}) - 60min patient action window]`;
        const triagedAppointment = await Appointment.findOneAndUpdate(
          { _id: appt._id, status: appt.status },
          {
            $set: {
              status: "disruption_triage",
              disruptionId,
              disruptedAt: now,
              disruptionNotifiedAt: now,
              disruptionResponseDeadline: responseDeadline,
              triageAction: "pending",
              notes,
            },
          },
          { returnDocument: "after" },
        )
          .populate("clinicId", "name phone organizationId")
          .populate("doctorId", "name email")
          .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
        if (!triagedAppointment) continue;

        remoteNotifiedCount++;

        triagedAppointments.push(triagedAppointment);

        // Send WhatsApp notification with interactive action URLs
        const patientDoc = triagedAppointment.patientId as any;
        const patientPhone = patientDoc?.phone || patientDoc?.userId?.phone;
        const patientName = patientDoc?.name || patientDoc?.userId?.name || "Patient";
        const doctorName = (triagedAppointment.doctorId as any)?.name || "Doctor";
        const clinicName = (triagedAppointment.clinicId as any)?.name || "Clinic";
        const formattedTime = new Date(triagedAppointment.appointmentTime).toLocaleDateString("en-US", {
          timeZone: timezone,
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        const { url: trackerUrl } = await issueAppointmentTrackerLink(triagedAppointment as any);
        const rescheduleUrl = `${trackerUrl}&action=reschedule`;
        const cancelUrl = `${trackerUrl}&action=cancel`;

        if (patientPhone) {
          SmsWhatsAppService.sendDisruptionAlert(
            triagedAppointment._id.toString(),
            organizationId || (triagedAppointment.clinicId as any)?.organizationId?.toString() || "",
            patientPhone,
            {
              patientName,
              doctorName,
              clinicName,
              appointmentTime: formattedTime,
              rescheduleUrl,
              cancelUrl,
              actionDeadlineMinutes: 60,
            }
          ).catch((err) => console.error("[DisruptionService] WhatsApp alert failed:", err));
        }

        // Publish domain event
        await eventBus.publishDurable({
          eventType: EVENT_TYPES.PATIENT_DISRUPTION_NOTIFIED,
          category: "patient",
          organizationId: organizationId || undefined,
          targetUserId: patientDoc?.userId?._id?.toString() || patientDoc?.userId?.toString(),
          title: "Doctor Schedule Disruption Alert",
          message: `Dr. ${doctorName} is unavailable on ${formattedTime}. Please reschedule or cancel within 60 minutes.`,
          severity: "warning",
          priority: "high",
          actionUrl: trackerUrl,
          metadata: {
            appointmentId: triagedAppointment._id.toString(),
            clinicId,
            doctorId,
            deadline: responseDeadline.toISOString(),
          },
        });
      }
    }

    // Broadcast alert to clinic reception if checked-in patients require triage
    if (checkedInTriageCount > 0) {
      broadcastQueueUpdate(clinicId, {
        type: "DISRUPTION_TRIAGE_REQUIRED",
        message: `${checkedInTriageCount} waiting patient(s) need immediate transfer or assistance.`,
        data: {
          title: "Urgent: Patients Require Triage",
          severity: "urgent",
          actionUrl: `/dashboard/queue`,
          clinicId,
          doctorId,
          count: checkedInTriageCount,
        },
      });
    }

    // Broadcast queue update for clinic
    broadcastQueueUpdate(clinicId, {
      type: "QUEUE_UPDATED",
      data: {
        clinicId,
        doctorId,
        date,
        overrideStatus: status,
        checkedInTriageCount,
        remoteNotifiedCount,
        inConsultationPreservedCount,
      },
      message: `Doctor availability modified: ${status}`,
      timestamp: now.toISOString(),
    });

    // Audit Log
    await AuditLog.create({
      userId,
      organizationId: organizationId ? new mongoose.Types.ObjectId(organizationId) : undefined,
      action: "DOCTOR_DISRUPTION_PROCESSED",
      targetId: disruptionId,
      targetModel: "DoctorDayOverride",
      details: {
        clinicId,
        doctorId,
        date,
        status,
        inConsultationPreservedCount,
        checkedInTriageCount,
        remoteNotifiedCount,
        totalAffected: checkedInTriageCount + remoteNotifiedCount,
      },
    });

    return {
      inConsultationPreservedCount,
      checkedInTriageCount,
      remoteNotifiedCount,
      triagedAppointmentsCount: triagedAppointments.length,
    };
  },

  /**
   * Finds eligible replacement doctors at the same clinic.
   * Doctor must:
   * 1. Have active DoctorAssignment at this clinic
   * 2. Not be the original disrupted doctor
   * 3. Not have an 'unavailable' DoctorDayOverride on this date
   */
  async getEligibleReplacementDoctors(clinicId: string, date: string, originalDoctorId: string) {
    const assignments = await DoctorAssignment.find({
      clinicId,
      doctorId: { $ne: new mongoose.Types.ObjectId(originalDoctorId) },
      isActive: true,
    }).populate("doctorId", "name email specialization");

    const eligibleDoctors: any[] = [];
    const timezone = await getClinicTimezone(clinicId);
    const { start: startOfDay, end: endOfDay } = clinicDayRange(date, timezone);
    const doctorIds = assignments.flatMap(assignment => assignment.doctorId ? [(assignment.doctorId as any)._id] : []);
    if (!doctorIds.length) return eligibleDoctors;
    const [overrides, loads] = await Promise.all([
      DoctorDayOverride.find({ clinicId, doctorId: { $in: doctorIds }, date }).select("doctorId status").lean(),
      Appointment.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
        { $match: { clinicId: new mongoose.Types.ObjectId(clinicId), doctorId: { $in: doctorIds },
          appointmentTime: { $gte: startOfDay, $lte: endOfDay }, status: { $in: ["confirmed", "checked-in", "in-consultation"] } } },
        { $group: { _id: "$doctorId", count: { $sum: 1 } } },
      ]),
    ]);
    const overrideByDoctor = new Map(overrides.map(override => [override.doctorId.toString(), override]));
    const loadByDoctor = new Map(loads.map(load => [load._id.toString(), load.count]));

    for (const assignment of assignments) {
      const docUser = assignment.doctorId as any;
      if (!docUser) continue;

      const override = overrideByDoctor.get(docUser._id.toString());

      if (override?.status === "unavailable") {
        continue;
      }

      const currentBookingsCount = loadByDoctor.get(docUser._id.toString()) || 0;

      eligibleDoctors.push({
        doctorId: docUser._id.toString(),
        name: docUser.name,
        email: docUser.email,
        specialization: docUser.specialization || "General Practice",
        fees: assignment.fees || 0,
        appointmentDuration: assignment.appointmentDuration || 15,
        bookingMode: assignment.bookingMode || "sequential_queue",
        maxDailyTokens: assignment.maxDailyTokens || null,
        currentBookingsCount,
        overrideStatus: override?.status || "available",
      });
    }

    return eligibleDoctors;
  },

  /**
   * Transfers a triaged patient to a replacement doctor.
   * Atomically assigns a new sequential token, updates invoice, notifies patient via WhatsApp, and logs audit trail.
   */
  async transferPatient(params: TransferPatientParams) {
    const { appointmentId, replacementDoctorId, transferredByUserId, reason } = params;

    const { appt, clinicId, previousDoctorId, previousDoctorName, targetDoctor, patientDoc, newTokenNumber } = await withClinicalTransaction(async () => {
      const appt = await Appointment.findById(appointmentId)
        .populate("clinicId", "name phone organizationId")
        .populate("doctorId", "name email")
        .populate({
          path: "patientId",
          populate: { path: "userId", select: "name email phone" },
        });

      if (!appt) {
        throw new Error("Appointment not found");
      }

      requirePendingDisruption(appt);

      const previousDoctorId = appt.doctorId?._id?.toString() || appt.doctorId?.toString();
      const previousDoctorName = (appt.doctorId as any)?.name || "Doctor";
      const previousToken = appt.tokenNumber;
      const clinicId = appt.clinicId?._id?.toString() || appt.clinicId?.toString();
      const isWaiting = appt.status === "checked-in" || appt.status === "disruption_triage";

      const targetDoctor = await User.findById(replacementDoctorId);
      if (!targetDoctor) {
        throw new Error("Replacement doctor not found");
      }
      if (replacementDoctorId === previousDoctorId) throw new AppointmentDomainError("Choose a different replacement doctor", 400);
      const replacementAssignment = await DoctorAssignment.findOne({ clinicId, doctorId: replacementDoctorId, isActive: true });
      if (!replacementAssignment || String(replacementAssignment.organizationId) !== String(appt.organizationId || (appt.clinicId as any)?.organizationId)) {
        throw new AppointmentDomainError("Replacement doctor is not assigned to this clinic", 404);
      }
      await validateAppointmentAvailability({ role: "doctor" }, {
        clinicId, doctorId: replacementDoctorId, appointmentTime: new Date(appt.appointmentTime).toISOString(),
        appointmentType: appt.appointmentType, duration: appt.duration,
      }, replacementAssignment, appt.id);

      // Determine target date boundary
      const apptDate = new Date(appt.appointmentTime);
      const timezone = await getClinicTimezone(clinicId);
      const { start: startOfDay, end: endOfDay } = clinicDayRange(clinicDateKey(apptDate, timezone), timezone);

      const newTokenNumber = await nextDisruptionToken(clinicId, replacementDoctorId, clinicDateKey(apptDate, timezone), startOfDay, endOfDay);
      if (replacementAssignment.maxDailyTokens && newTokenNumber > replacementAssignment.maxDailyTokens) throw new AppointmentDomainError("Replacement doctor's daily token limit has been reached", 409);
      const claimed = await Appointment.updateOne({ _id: appt._id, status: "disruption_triage", triageAction: "pending" }, { $set: { triageAction: "transferred" } });
      if (!claimed.modifiedCount) throw new AppointmentDomainError("Appointment was changed by another request", 409);

      // Determine Queue Priority:
      // When a patient already waiting at the clinic is transferred to Doctor B,
      // they must be placed IMMEDIATELY behind Doctor B's active consultation -> Next Up (queuePosition = 1)!
      let assignedQueuePosition = 1;
      if (isWaiting) {
        // Find all existing waiting patients for Doctor B today
        const existingWaiting = await Appointment.find({
          clinicId,
          doctorId: replacementDoctorId,
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["checked-in", "confirmed", "pending"] },
          _id: { $ne: appt._id },
        }).sort({ queuePosition: 1, tokenNumber: 1 });

        assignedQueuePosition = 1; // Immediately behind active consultation -> Next Up!

        // Shift existing waiting queue positions down to preserve ordering
        for (let i = 0; i < existingWaiting.length; i++) {
          existingWaiting[i].queuePosition = i + 2;
          await existingWaiting[i].save();
        }
      } else {
        const countWaiting = await Appointment.countDocuments({
          clinicId,
          doctorId: replacementDoctorId,
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["checked-in", "confirmed", "pending"] },
          _id: { $ne: appt._id },
        });
        assignedQueuePosition = countWaiting + 1;
      }

      // Calculate Fee Variance & Financial Reconciliation between previous and replacement doctor
      const [prevAssignment, repAssignment] = await Promise.all([
        DoctorAssignment.findOne({ doctorId: previousDoctorId, clinicId }),
        DoctorAssignment.findOne({ doctorId: replacementDoctorId, clinicId }),
      ]);

      const prevFee = (prevAssignment?.fees ?? (prevAssignment as any)?.consultationFee) || 0;
      const repFee = (repAssignment?.fees ?? (repAssignment as any)?.consultationFee) || 0;
      const feeVariance = repFee - prevFee;
      let feeResolution: "waived_courtesy" | "paid_difference" | "partial_refund" | "exact_match" = "exact_match";

      if (feeVariance > 0) {
        feeResolution = "waived_courtesy";
      } else if (feeVariance < 0) {
        feeResolution = "partial_refund";
      }

      // Mutate appointment
      appt.originalDoctorId = new mongoose.Types.ObjectId(previousDoctorId);
      appt.originalTokenNumber = previousToken;
      appt.doctorId = new mongoose.Types.ObjectId(replacementDoctorId);
      appt.bookingMode = replacementAssignment.bookingMode;
      appt.tokenNumber = newTokenNumber;
      appt.queuePosition = assignedQueuePosition;
      appt.transferredAt = new Date();
      appt.transferredBy = new mongoose.Types.ObjectId(transferredByUserId);
      appt.triageAction = "transferred";
      appt.status = isWaiting ? "checked-in" : "confirmed";
      appt.feeVariance = feeVariance;
      appt.feeResolution = feeResolution;
      appt.notes = appt.notes
        ? `${appt.notes} | [PRIORITY TRANSFER: Next up for Dr. ${targetDoctor.name} (transferred from Dr. ${previousDoctorName}): ${reason || "Disruption reassignment"}]`
        : `[PRIORITY TRANSFER: Next up for Dr. ${targetDoctor.name} (transferred from Dr. ${previousDoctorName}): ${reason || "Disruption reassignment"}]`;

      await appt.save();

      // Update corresponding Invoice doctor reference, notes, and fee waiver documentation
      const feeNote = feeVariance > 0
        ? ` | Disruption Courtesy: Original fee ₹${prevFee} honored (₹${feeVariance} difference absorbed by clinic)`
        : feeVariance < 0
        ? ` | Disruption Reassignment: Original fee ₹${prevFee} vs Replacement fee ₹${repFee}`
        : "";

      await Invoice.updateMany(
        { appointmentId: appt._id },
        {
          $set: {
            doctorId: new mongoose.Types.ObjectId(replacementDoctorId),
            notes: `Doctor reassigned from Dr. ${previousDoctorName} to Dr. ${targetDoctor.name}${feeNote}`,
          },
        }
      );

      const patientDoc = appt.patientId as any;
      const auditUserId = mongoose.Types.ObjectId.isValid(transferredByUserId)
        ? new mongoose.Types.ObjectId(transferredByUserId)
        : (patientDoc?.userId?._id || new mongoose.Types.ObjectId());

      // Immutable Audit Log: APPOINTMENT_TRANSFERRED { fromDoctor, toDoctor, reason, staffId, feeVariance }
      await AuditLog.create({
        userId: auditUserId,
        organizationId: appt.organizationId || (appt.clinicId as any)?.organizationId,
        action: "APPOINTMENT_TRANSFERRED",
        targetId: appt._id,
        targetModel: "Appointment",
        category: "ADMIN",
        details: {
          fromDoctor: previousDoctorId,
          toDoctor: replacementDoctorId,
          fromDoctorName: previousDoctorName,
          toDoctorName: targetDoctor.name,
          reason: reason || "Doctor schedule disruption transfer",
          staffId: transferredByUserId,
          originalToken: previousToken,
          newToken: newTokenNumber,
          queuePosition: assignedQueuePosition,
          isPriorityNextUp: isWaiting,
          originalFee: prevFee,
          replacementFee: repFee,
          feeVariance,
          feeResolution,
        },
      });

      return { appt, clinicId, previousDoctorId, previousDoctorName, replacementDoctorId, targetDoctor, patientDoc, newTokenNumber };
    });
    appt.$session(null);
    const { url: trackerUrl } = await issueAppointmentTrackerLink(appt as any);

    // Domain Event
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.PATIENT_TRANSFERRED_DOCTOR,
      category: "patient",
      organizationId: (appt.clinicId as any)?.organizationId?.toString(),
      targetUserId: patientDoc?.userId?._id?.toString() || patientDoc?.userId?.toString(),
      title: "Appointment Transferred",
      message: `Your appointment has been transferred to Dr. ${targetDoctor.name}. Your new token is #${newTokenNumber}.`,
      severity: "info",
      actionUrl: trackerUrl,
      metadata: {
        appointmentId: appt._id.toString(),
        previousDoctorId,
        replacementDoctorId,
        newTokenNumber,
      },
    });

    // WhatsApp Notification
    const patientPhone = patientDoc?.phone || patientDoc?.userId?.phone;
    const patientName = patientDoc?.name || patientDoc?.userId?.name || "Patient";
    const clinicName = (appt.clinicId as any)?.name || "Clinic";

    if (patientPhone) {
      SmsWhatsAppService.sendDisruptionTransferAlert(
        appt._id.toString(),
        (appt.clinicId as any)?.organizationId?.toString() || "",
        patientPhone,
        {
          patientName,
          originalDoctorName: previousDoctorName,
          newDoctorName: targetDoctor.name,
          clinicName,
          tokenNumber: newTokenNumber,
          trackingUrl: trackerUrl,
        }
      ).catch((err) => console.error("[DisruptionService] WhatsApp transfer alert failed:", err));
    }

    // Real-time queue broadcasts for both doctors
    broadcastQueueUpdate(clinicId, {
      type: "QUEUE_UPDATED",
      data: { clinicId, doctorId: previousDoctorId },
      message: `Patient transferred to Dr. ${targetDoctor.name}`,
      timestamp: new Date().toISOString(),
    });

    broadcastQueueUpdate(clinicId, {
      type: "QUEUE_UPDATED",
      data: { clinicId, doctorId: replacementDoctorId },
      message: `New patient transferred from Dr. ${previousDoctorName}`,
      timestamp: new Date().toISOString(),
    });

    return appt;
  },

  /**
   * Cancels an appointment due to doctor disruption and processes refund for prepaid bookings.
   */
  async cancelByDisruption(params: CancelDisruptionParams) {
    const { appointmentId, cancelledByUserId, reason, timeoutClaimToken } = params;

    let appt = await Appointment.findById(appointmentId)
      .populate("clinicId", "name phone organizationId")
      .populate("doctorId", "name email")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) {
      throw new Error("Appointment not found");
    }

    const timeoutClaim = cancelledByUserId === "system" && timeoutClaimToken && appt.triageAction === "timeout_processing"
      && appt.disruptionTimeoutClaimToken === timeoutClaimToken;
    if (!timeoutClaim) requirePendingDisruption(appt);
    if (appt.status !== "disruption_triage") throw new AppointmentDomainError("Appointment is no longer awaiting a disruption response", 409);
    const previousPaymentStatus = appt.paymentStatus;
    const claimed = await withClinicalTransaction(() => Appointment.findOneAndUpdate(
      { _id: appt!._id, status: "disruption_triage", paymentStatus: previousPaymentStatus, triageAction: timeoutClaim ? "timeout_processing" : "pending",
        ...(timeoutClaim ? { disruptionTimeoutClaimToken: timeoutClaimToken } : {}) },
      { $set: { status: "cancelled", triageAction: "cancelled", paymentStatus: previousPaymentStatus === "paid" ? "refund_pending" : previousPaymentStatus,
        cancellationReason: reason || "Doctor schedule disruption",
        notes: `${appt!.notes ? `${appt!.notes} | ` : ""}[Cancelled due to doctor disruption: ${reason || "Doctor unavailable"}]` } },
      { returnDocument: "after" },
    ).populate("clinicId", "name phone organizationId").populate("doctorId", "name email")
      .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } }));
    if (!claimed) throw new AppointmentDomainError("Appointment was changed by another request", 409);
    appt = claimed;
    appt.$session(null);

    const patientDoc = appt.patientId as any;
    const clinicId = appt.clinicId?._id?.toString() || appt.clinicId?.toString();
    const doctorId = appt.doctorId?._id?.toString() || appt.doctorId?.toString();
    const doctorName = (appt.doctorId as any)?.name || "Doctor";
    const clinicName = (appt.clinicId as any)?.name || "Clinic";
    const patientName = patientDoc?.name || patientDoc?.userId?.name || "Patient";
    const patientPhone = patientDoc?.phone || patientDoc?.userId?.phone;

    const auditUserId = mongoose.Types.ObjectId.isValid(cancelledByUserId)
      ? new mongoose.Types.ObjectId(cancelledByUserId)
      : (patientDoc?.userId?._id || new mongoose.Types.ObjectId());

    let refundProcessed = false;
    let refundAmount = 0;
    let refundId = "";

    // If appointment is prepaid, execute refund
    if (previousPaymentStatus === "paid") {
      const invoice = await Invoice.findOne({ appointmentId: appt._id });
      const source = await onlineRefundSource(appt, invoice);
      refundAmount = source?.amount || 0;

      appt.paymentStatus = "refund_pending";

      if (source) {
        await AuditLog.create({ userId: auditUserId, organizationId: appt.organizationId || (appt.clinicId as any)?.organizationId,
          action: "REFUND_REQUESTED", targetId: appt._id, targetModel: "Appointment", category: "BILLING",
          details: { paymentId: source.paymentId, amount: source.amount, currency: source.currency } });
        // Cash, split receipts and missing provider references need manual billing review.
        const refundResult = await paymentProvider.processRefund({
          transactionId: source.paymentId,
          amount: refundAmount,
          reason: `Doctor Disruption Cancellation: ${reason || "Doctor unavailable"}`,
        }).catch((error) => {
          console.error("[DisruptionService] Automatic refund failed:", error);
          return null;
        });

        refundId = refundResult?.refundId || "";
        if (refundResult?.status === "processed") {
          appt.paymentStatus = "refunded";
          appt.triageAction = "refunded";
          refundProcessed = true;

          if (invoice) {
            invoice.status = "refunded";
          }
          await withClinicalTransaction(async () => {
            if (invoice) await invoice.save();
            await appt!.save();
          });
          appt.$session(null);
          invoice?.$session(null);

          // Emit refund domain event
          await eventBus.publishDurable({
            eventType: EVENT_TYPES.PATIENT_DISRUPTION_REFUNDED,
            category: "billing",
            organizationId: (appt.clinicId as any)?.organizationId?.toString(),
            targetUserId: patientDoc?.userId?._id?.toString() || patientDoc?.userId?.toString(),
            title: "Refund Processed",
            message: `A refund of ₹${refundAmount} has been processed for your appointment with Dr. ${doctorName}.`,
            severity: "info",
            actionUrl: `/dashboard/billing`,
            metadata: { appointmentId: appt._id.toString(), refundId, refundAmount },
          });

          // WhatsApp Refund Confirmation
          if (patientPhone) {
            SmsWhatsAppService.sendDisruptionRefundAlert(
              appt._id.toString(),
              (appt.clinicId as any)?.organizationId?.toString() || "",
              patientPhone,
              {
                patientName,
                doctorName,
                clinicName,
                refundAmount,
                refundId,
              }
            ).catch((err) => console.error("[DisruptionService] WhatsApp refund alert failed:", err));
          }
          // Immutable Audit Log: APPOINTMENT_REFUNDED
          await AuditLog.create({
            userId: auditUserId,
            organizationId: (appt.clinicId as any)?.organizationId,
            action: "APPOINTMENT_REFUNDED",
            targetId: invoice?._id || appt._id,
            targetModel: "Invoice",
            category: "BILLING",
            details: {
              appointmentId: appt._id.toString(),
              invoiceId: invoice?._id?.toString(),
              amount: refundAmount,
              refundId,
              reason: `Doctor Disruption Cancellation: ${reason || "Doctor unavailable"}`,
              staffId: cancelledByUserId,
            },
          });
        }
      }
    } else {
      // Cancel any unpaid invoices
      await Invoice.updateMany({ appointmentId: appt._id, status: "unpaid" }, { status: "cancelled" });
    }

    await appt.save();

    // Immutable Audit Log: APPOINTMENT_CANCELLED
    await AuditLog.create({
      userId: auditUserId,
      organizationId: appt.organizationId || (appt.clinicId as any)?.organizationId,
      action: "APPOINTMENT_CANCELLED",
      targetId: appt._id,
      targetModel: "Appointment",
      category: "ADMIN",
      details: {
        appointmentId: appt._id.toString(),
        fromDoctor: doctorId,
        doctorId,
        clinicId,
        staffId: cancelledByUserId,
        refundProcessed,
        refundAmount,
        refundId,
        reason: reason || "Doctor schedule disruption",
      },
    });

    // Domain Event
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.PATIENT_DISRUPTION_CANCELLED,
      category: "patient",
      organizationId: (appt.clinicId as any)?.organizationId?.toString(),
      targetUserId: patientDoc?.userId?._id?.toString() || patientDoc?.userId?.toString(),
      title: "Appointment Cancelled",
      message: `Your appointment with Dr. ${doctorName} has been cancelled due to doctor unavailability.`,
      severity: "warning",
      actionUrl: `/dashboard/appointments`,
      metadata: { appointmentId: appt._id.toString(), doctorId, reason },
    });

    // Real-time queue broadcast
    broadcastQueueUpdate(clinicId, {
      type: "QUEUE_UPDATED",
      data: { clinicId, doctorId },
      message: "Appointment cancelled due to schedule disruption",
      timestamp: new Date().toISOString(),
    });

    return appt;
  },

  /**
   * Reschedules a disrupted appointment with highest priority for next available slot/date.
   * Payment status and records are preserved.
   */
  async priorityReschedule(params: PriorityRescheduleParams) {
    const { appointmentId, targetDate, targetDoctorId, targetTimeSlot, rescheduledByUserId, reason } = params;

    const { originalAppt, newAppt, clinicId, doctorId, patientDoc, newTokenNumber, newAppointmentTime, timezone } = await withClinicalTransaction(async () => {
      const originalAppt = await Appointment.findById(appointmentId)
        .populate("clinicId", "name phone organizationId")
        .populate("doctorId", "name email")
        .populate({
          path: "patientId",
          populate: { path: "userId", select: "name email phone" },
        });

      if (!originalAppt) {
        throw new Error("Appointment not found");
      }

      requirePendingDisruption(originalAppt);

      const clinicId = originalAppt.clinicId?._id?.toString() || originalAppt.clinicId?.toString();
      const doctorId = targetDoctorId || originalAppt.doctorId?._id?.toString() || originalAppt.doctorId?.toString();

      const timezone = await getClinicTimezone(clinicId);
      let newAppointmentTime: Date;
      try { newAppointmentTime = clinicLocalTimeToDate(targetDate, targetTimeSlot || "09:00", timezone); }
      catch { throw new AppointmentDomainError("Invalid clinic date or time", 400); }
      const { start: startOfDay, end: endOfDay } = clinicDayRange(targetDate, timezone);

      const assignment = await DoctorAssignment.findOne({ clinicId, doctorId, isActive: true });
      if (!assignment || String(assignment.organizationId) !== String(originalAppt.organizationId || (originalAppt.clinicId as any)?.organizationId)) {
        throw new AppointmentDomainError("Doctor is not assigned to this clinic", 404);
      }
      const actor = mongoose.Types.ObjectId.isValid(rescheduledByUserId) ? await User.findById(rescheduledByUserId).select("role") : null;
      await validateAppointmentAvailability({ role: actor?.role || "patient" }, {
        clinicId, doctorId, appointmentTime: newAppointmentTime.toISOString(), appointmentType: originalAppt.appointmentType,
        duration: originalAppt.duration,
      }, assignment, originalAppt.id);

      // Get next token on target date
      const newTokenNumber = await nextDisruptionToken(clinicId, doctorId, targetDate, startOfDay, endOfDay);
      if (assignment.maxDailyTokens && newTokenNumber > assignment.maxDailyTokens) throw new AppointmentDomainError("Doctor's daily token limit has been reached", 409);
      const claimed = await Appointment.updateOne({ _id: originalAppt._id, status: "disruption_triage", triageAction: "pending" }, { $set: { status: "cancelled", triageAction: "rescheduled" } });
      if (!claimed.modifiedCount) throw new AppointmentDomainError("Appointment was changed by another request", 409);

      if (assignment.bookingMode === "sequential_queue") {
        const waiting = await Appointment.find({ clinicId, doctorId, appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["pending", "confirmed", "checked-in"] }, _id: { $ne: originalAppt._id } }).sort({ queuePosition: 1, tokenNumber: 1 });
        for (let index = 0; index < waiting.length; index++) {
          waiting[index].queuePosition = index + 2;
          await waiting[index].save();
        }
      }

      // Create new priority appointment
      const newAppt = await Appointment.create({
        organizationId: originalAppt.organizationId || (originalAppt.clinicId as any)?.organizationId,
        clinicId,
        doctorId,
        patientId: originalAppt.patientId?._id || originalAppt.patientId,
        bookedByUserId: originalAppt.bookedByUserId,
        appointmentTime: newAppointmentTime,
        appointmentType: originalAppt.appointmentType,
        status: "confirmed",
        paymentStatus: originalAppt.paymentStatus, // carry forward prepaid status!
        bookingSource: originalAppt.bookingSource,
        tokenNumber: newTokenNumber,
        queuePosition: assignment.bookingMode === "sequential_queue" ? 1 : newTokenNumber,
        bookingMode: assignment.bookingMode,
        duration: originalAppt.duration || 15,
        reasonForVisit: originalAppt.reasonForVisit,
        priorityRescheduledFromId: originalAppt._id,
        notes: `[Priority Rescheduled from ${clinicDateKey(new Date(originalAppt.appointmentTime), timezone)}: ${reason || "Disruption"}]`,
      });

      // Mark original appointment as rescheduled
      originalAppt.status = "cancelled";
      originalAppt.triageAction = "rescheduled";
      originalAppt.cancellationReason = `Priority Rescheduled to ${targetDate}`;
      originalAppt.notes = originalAppt.notes
        ? `${originalAppt.notes} | [Rescheduled to ${targetDate} - New Appointment ID: ${newAppt._id}]`
        : `[Rescheduled to ${targetDate} - New Appointment ID: ${newAppt._id}]`;
      await originalAppt.save();

      // Carry forward invoice if paid
      if (originalAppt.paymentStatus === "paid") {
        await Invoice.updateMany(
          { appointmentId: originalAppt._id },
          {
            appointmentId: newAppt._id,
            notes: `Carried forward from appointment ${originalAppt._id}`,
          }
        );
      }

      const patientDoc = originalAppt.patientId as any;
      const auditUserId = mongoose.Types.ObjectId.isValid(rescheduledByUserId)
        ? new mongoose.Types.ObjectId(rescheduledByUserId)
        : (patientDoc?.userId?._id || new mongoose.Types.ObjectId());

      // Immutable Audit Log: APPOINTMENT_RESCHEDULED
      await AuditLog.create({
        userId: auditUserId,
        organizationId: originalAppt.organizationId || (originalAppt.clinicId as any)?.organizationId,
        action: "APPOINTMENT_RESCHEDULED",
        targetId: originalAppt._id,
        targetModel: "Appointment",
        category: "ADMIN",
        details: {
          originalAppointmentId: originalAppt._id.toString(),
          newAppointmentId: newAppt._id.toString(),
          fromDoctor: originalAppt.doctorId.toString(),
          toDoctor: doctorId,
          targetDate,
          reason: reason || "Doctor schedule disruption",
          staffId: rescheduledByUserId,
          newTokenNumber,
          priorityQueuePosition: 1,
        },
      });

      return { originalAppt, newAppt, clinicId, doctorId, patientDoc, newTokenNumber, newAppointmentTime, timezone };
    });
    originalAppt.$session(null);
    newAppt.$session(null);
    const { url: newAppointmentTrackerUrl } = await issueAppointmentTrackerLink(newAppt as any);

    // Domain Event
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.PATIENT_PRIORITY_RESCHEDULED,
      category: "patient",
      organizationId: (originalAppt.clinicId as any)?.organizationId?.toString(),
      targetUserId: patientDoc?.userId?._id?.toString() || patientDoc?.userId?.toString(),
      title: "Appointment Rescheduled",
      message: `Your appointment has been rescheduled to ${targetDate} with token #${newTokenNumber}.`,
      severity: "success",
      actionUrl: newAppointmentTrackerUrl,
      metadata: {
        originalAppointmentId: originalAppt._id.toString(),
        newAppointmentId: newAppt._id.toString(),
        targetDate,
        tokenNumber: newTokenNumber,
      },
    });

    // WhatsApp Notification for new booking
    const patientPhone = patientDoc?.phone || patientDoc?.userId?.phone;
    const patientName = patientDoc?.name || patientDoc?.userId?.name || "Patient";
    const doctor = await User.findById(doctorId);

    if (patientPhone) {
      SmsWhatsAppService.sendBookingConfirmation(
        newAppt._id.toString(),
        (originalAppt.clinicId as any)?.organizationId?.toString() || "",
        patientPhone,
        {
          patientName,
          tokenNumber: newTokenNumber,
          doctorName: doctor?.name || "Doctor",
          clinicName: (originalAppt.clinicId as any)?.name || "Clinic",
          date: targetDate,
          appointmentTime: newAppointmentTime.toLocaleTimeString([], { timeZone: timezone, hour: "2-digit", minute: "2-digit" }),
          trackingUrl: newAppointmentTrackerUrl,
        }
      ).catch((err) => console.error("[DisruptionService] WhatsApp reschedule confirmation failed:", err));
    }

    // Real-time queue broadcast
    broadcastQueueUpdate(clinicId, {
      type: "QUEUE_UPDATED",
      data: { clinicId, doctorId },
      message: "New appointment scheduled via priority reschedule",
      timestamp: new Date().toISOString(),
    });

    return { originalAppt, newAppt };
  },

  /**
   * Batch action for multiple appointments (transfer, cancel, or reschedule).
   */
  async batchTriageAction(params: BatchTriageParams) {
    const { action, appointmentIds, actorUserId, replacementDoctorId, targetDate, targetTimeSlot, reason } = params;

    let successfulCount = 0;
    let failedCount = 0;
    const errors: Array<{ appointmentId: string; error: string }> = [];
    const processed: any[] = [];

    for (const apptId of appointmentIds) {
      try {
        if (action === "transfer") {
          if (!replacementDoctorId) throw new Error("replacementDoctorId is required for transfer");
          const res = await this.transferPatient({
            appointmentId: apptId,
            replacementDoctorId,
            transferredByUserId: actorUserId,
            reason,
          });
          processed.push(res);
          successfulCount++;
        } else if (action === "cancel") {
          const res = await this.cancelByDisruption({
            appointmentId: apptId,
            cancelledByUserId: actorUserId,
            reason,
          });
          processed.push(res);
          successfulCount++;
        } else if (action === "reschedule") {
          if (!targetDate) throw new Error("targetDate is required for reschedule");
          const res = await this.priorityReschedule({
            appointmentId: apptId,
            targetDate,
            targetDoctorId: replacementDoctorId,
            targetTimeSlot,
            rescheduledByUserId: actorUserId,
            reason,
          });
          processed.push(res);
          successfulCount++;
        }
      } catch (err: any) {
        failedCount++;
        errors.push({ appointmentId: apptId, error: err.message || String(err) });
      }
    }

    return { successfulCount, failedCount, errors, processed };
  },

  /**
   * Disruption timeout sweeper: Finds un-actioned remote appointments whose 60-min window expired,
   * automatically cancels and processes refunds.
   */
  async processDisruptionTimeout() {
    const now = new Date();
    const staleClaimBefore = new Date(now.getTime() - 15 * 60 * 1000);
    const expiredAppointments = await Appointment.find({
      status: "disruption_triage",
      disruptionResponseDeadline: { $lte: now },
      $or: [
        { triageAction: "pending" },
        {
          triageAction: "timeout_processing",
          disruptionTimeoutClaimedAt: { $lte: staleClaimBefore },
        },
      ],
    });

    let autoCancelledCount = 0;
    for (const appt of expiredAppointments) {
      const claimToken = crypto.randomUUID();
      try {
        // Scheduler leadership prevents normal duplicate sweeps; this CAS is
        // the fencing layer if a worker dies or loses its lease mid-sweep.
        const claimedAppointment = await Appointment.findOneAndUpdate(
          {
            _id: appt._id,
            status: "disruption_triage",
            disruptionResponseDeadline: { $lte: now },
            $or: [
              { triageAction: "pending" },
              {
                triageAction: "timeout_processing",
                disruptionTimeoutClaimedAt: { $lte: staleClaimBefore },
              },
            ],
          },
          {
            $set: {
              triageAction: "timeout_processing",
              disruptionTimeoutClaimedAt: now,
              disruptionTimeoutClaimToken: claimToken,
            },
          },
          { returnDocument: "after" },
        );
        if (!claimedAppointment) continue;

        await this.cancelByDisruption({
          appointmentId: appt._id.toString(),
          cancelledByUserId: "system",
          reason: "Disruption 60-minute patient response window expired",
          timeoutClaimToken: claimToken,
        });
        autoCancelledCount++;
      } catch (err) {
        // A delivery/provider failure should be retried by a later sweep, but
        // only the worker that owns this claim may return it to pending.
        await Appointment.updateOne(
          {
            _id: appt._id,
            status: "disruption_triage",
            triageAction: "timeout_processing",
            disruptionTimeoutClaimToken: claimToken,
          },
          {
            $set: { triageAction: "pending" },
            $unset: { disruptionTimeoutClaimedAt: 1, disruptionTimeoutClaimToken: 1 },
          },
        );
        console.error(`[DisruptionService] Failed to auto-cancel expired appointment ${appt._id}:`, err);
      }
    }

    return { autoCancelledCount, totalExpiredFound: expiredAppointments.length };
  },
};

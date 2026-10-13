import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { publishAppointmentCommunication } from "./AppointmentCommunicationEvents.ts";
import { createCrmTask } from "./CrmTaskService.ts";
import { Location } from "../models/Location.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { onlineRefundSource } from "./AppointmentRefundService.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { recordAppointmentRecovery, resolveAppointmentRecovery } from "./CareFollowUpService.ts";
import { User } from "../models/User.ts";
import { broadcastQueueUpdate } from "../notifications/websocket.ts";
import { paymentProvider } from "./payment/PaymentProvider.ts";
import { withClinicalTransaction } from "../utilities/transaction.ts";
import { Counter, getNextAtomicSequence } from "../models/Counter.ts";
import { AppointmentDomainError, validateAppointmentAvailability } from "./AppointmentService.ts";
import { locationClockMinutes, locationDateKey, locationDayRange, locationLocalTimeToDate, getLocationTimezone } from "../utilities/locationTime.ts";

function requirePendingDisruption(appointment: any) {
  if (appointment.status !== "disruption_triage" || appointment.triageAction !== "pending") {
    throw new AppointmentDomainError("Appointment is no longer awaiting a disruption response", 409);
  }
}

async function communicationActor(userId: string) {
  if (!mongoose.Types.ObjectId.isValid(userId)) return undefined;
  const actor = await User.findById(userId).select('role').lean();
  return actor && !['patient', 'family_member', 'guest'].includes(actor.role) ? userId : undefined;
}

async function nextDisruptionToken(locationId: string, doctorId: string, date: string, start: Date, end: Date) {
  const key = `token_${locationId}_${doctorId}_${date}`;
  const last = await Appointment.findOne({ locationId, doctorId, appointmentTime: { $gte: start, $lte: end } }).sort({ tokenNumber: -1 }).select("tokenNumber");
  // Adopt imported queue tokens without moving the canonical counter backwards.
  await Counter.findOneAndUpdate({ id: key }, { $max: { seq: last?.tokenNumber || 0 } }, { upsert: true });
  return getNextAtomicSequence(key);
}

export interface ProcessDisruptionParams {
  locationId: string;
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
   * - Confirmed/pending patients enter staff review with consent-aware durable communication
   */
  async processDoctorDisruption(params: ProcessDisruptionParams) {
    const {
      locationId,
      doctorId,
      date,
      status,
      effectiveEndTime,
      reason,
      userId,
      organizationId,
      disruptionId,
    } = params;

    const timezone = await getLocationTimezone(locationId);
    const { start: startOfDay, end: endOfDay } = locationDayRange(date, timezone);

    let closingMinutes = 24 * 60;
    if (effectiveEndTime && status !== "unavailable") {
      const [endH, endM] = effectiveEndTime.split(":").map(Number);
      closingMinutes = (endH || 0) * 60 + (endM || 0);
    }

    const appointments = await Appointment.find({
      locationId,
      doctorId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      status: { $in: ["in-consultation", "checked-in", "confirmed", "pending", "pending_payment"] },
    })
      .populate("locationId", "name phone organizationId")
      .populate("doctorId", "name email")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    let inConsultationPreservedCount = 0;
    let checkedInTriageCount = 0;
    let remoteTriageCount = 0;
    const triagedAppointments: any[] = [];

    const now = new Date();
    const reviewDueAt = new Date(now.getTime() + 60 * 60 * 1000);

    for (const appt of appointments) {
      const apptDate = new Date(appt.appointmentTime);
      const apptMinutes = locationClockMinutes(apptDate, timezone);
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
        const triagedAppointment = await withClinicalTransaction(async () => {
          const claimed = await Appointment.findOneAndUpdate(
          { _id: appt._id, status: "checked-in" },
          {
            $set: {
              status: "disruption_triage",
              disruptionOriginalStatus: "checked-in",
              disruptionId,
              disruptedAt: now,
              triageAction: "pending",
              notes,
            },
          },
          { returnDocument: "after" },
        )
          .populate("locationId", "name phone organizationId")
          .populate("doctorId", "name email")
          .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
          if (claimed) await recordAppointmentRecovery(claimed, userId, "disruption");
          return claimed;
        });
        triagedAppointment?.$session(null);
        if (!triagedAppointment) continue;

        checkedInTriageCount++;

        const patientDoc = triagedAppointment.patientId as any;
        triagedAppointments.push(triagedAppointment);

        continue;
      }

      // 3. Confirmed & Pending patients: Remote triage with staff review if unanswered
      if (["confirmed", "pending", "pending_payment"].includes(appt.status)) {
        const notes = appt.notes
          ? `${appt.notes} | [Doctor unavailable (${status}) - awaiting patient or reception action]`
          : `[Doctor unavailable (${status}) - awaiting patient or reception action]`;
        const triagedAppointment = await withClinicalTransaction(async () => {
          const claimed = await Appointment.findOneAndUpdate(
          { _id: appt._id, status: appt.status },
          {
            $set: {
              status: "disruption_triage",
              disruptionOriginalStatus: appt.status,
              disruptionId,
              disruptedAt: now,
              disruptionReviewDueAt: reviewDueAt,
              triageAction: "pending",
              notes,
            },
          },
          { returnDocument: "after" },
        )
          .populate("locationId", "name phone organizationId")
          .populate("doctorId", "name email")
          .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
          if (claimed) {
            await recordAppointmentRecovery(claimed, userId, "disruption");
            await publishAppointmentCommunication(claimed, { action: "disruption", actorId: userId });
          }
          return claimed;
        });
        triagedAppointment?.$session(null);
        if (!triagedAppointment) continue;

        remoteTriageCount++;

        triagedAppointments.push(triagedAppointment);


      }
    }

    // Broadcast alert to location reception if checked-in patients require triage
    if (checkedInTriageCount > 0) {
      broadcastQueueUpdate(locationId, {
        type: "DISRUPTION_TRIAGE_REQUIRED",
        message: `${checkedInTriageCount} waiting patient(s) need immediate transfer or assistance.`,
        data: {
          title: "Urgent: Patients Require Triage",
          severity: "urgent",
          actionUrl: `/dashboard/queue`,
          locationId,
          doctorId,
          count: checkedInTriageCount,
        },
      });
    }

    // Broadcast queue update for location
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: {
        locationId,
        doctorId,
        date,
        overrideStatus: status,
        checkedInTriageCount,
        remoteTriageCount,
        remoteNotifiedCount: 0,
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
        locationId,
        doctorId,
        date,
        status,
        inConsultationPreservedCount,
        checkedInTriageCount,
        remoteTriageCount,
        remoteNotifiedCount: 0,
        totalAffected: checkedInTriageCount + remoteTriageCount,
      },
    });

    return {
      inConsultationPreservedCount,
      checkedInTriageCount,
      remoteTriageCount,
      remoteNotifiedCount: 0,
      triagedAppointmentsCount: triagedAppointments.length,
    };
  },

  /**
   * Finds eligible replacement doctors at the same location.
   * Doctor must:
   * 1. Have active DoctorAssignment at this location
   * 2. Not be the original disrupted doctor
   * 3. Not have an 'unavailable' DoctorDayOverride on this date
   */
  async getEligibleReplacementDoctors(locationId: string, date: string, originalDoctorId: string) {
    const assignments = await DoctorAssignment.find({
      locationId,
      doctorId: { $ne: new mongoose.Types.ObjectId(originalDoctorId) },
      isActive: true,
    }).populate("doctorId", "name email specialization");

    const eligibleDoctors: any[] = [];
    const timezone = await getLocationTimezone(locationId);
    const { start: startOfDay, end: endOfDay } = locationDayRange(date, timezone);
    const doctorIds = assignments.flatMap(assignment => assignment.doctorId ? [(assignment.doctorId as any)._id] : []);
    if (!doctorIds.length) return eligibleDoctors;
    const [overrides, loads] = await Promise.all([
      DoctorDayOverride.find({ locationId, doctorId: { $in: doctorIds }, date }).select("doctorId status").lean(),
      Appointment.aggregate<{ _id: mongoose.Types.ObjectId; count: number }>([
        { $match: { locationId: new mongoose.Types.ObjectId(locationId), doctorId: { $in: doctorIds },
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

    const { appt, locationId, previousDoctorId, previousDoctorName, targetDoctor, patientDoc, newTokenNumber } = await withClinicalTransaction(async () => {
      const appt = await Appointment.findById(appointmentId)
        .populate("locationId", "name phone organizationId")
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
      const locationId = appt.locationId?._id?.toString() || appt.locationId?.toString();
      const isWaiting = appt.status === "checked-in" || appt.status === "disruption_triage";

      const targetDoctor = await User.findById(replacementDoctorId);
      if (!targetDoctor) {
        throw new Error("Replacement doctor not found");
      }
      if (replacementDoctorId === previousDoctorId) throw new AppointmentDomainError("Choose a different replacement doctor", 400);
      const replacementAssignment = await DoctorAssignment.findOne({ locationId, doctorId: replacementDoctorId, isActive: true });
      if (!replacementAssignment || String(replacementAssignment.organizationId) !== String(appt.organizationId || (appt.locationId as any)?.organizationId)) {
        throw new AppointmentDomainError("Replacement doctor is not assigned to this location", 404);
      }
      await validateAppointmentAvailability({ role: "doctor" }, {
        locationId, doctorId: replacementDoctorId, appointmentTime: new Date(appt.appointmentTime).toISOString(),
        appointmentType: appt.appointmentType, duration: appt.duration,
      }, replacementAssignment, appt.id);

      // Determine target date boundary
      const apptDate = new Date(appt.appointmentTime);
      const timezone = await getLocationTimezone(locationId);
      const { start: startOfDay, end: endOfDay } = locationDayRange(locationDateKey(apptDate, timezone), timezone);

      const newTokenNumber = await nextDisruptionToken(locationId, replacementDoctorId, locationDateKey(apptDate, timezone), startOfDay, endOfDay);
      if (replacementAssignment.maxDailyTokens && newTokenNumber > replacementAssignment.maxDailyTokens) throw new AppointmentDomainError("Replacement doctor's daily token limit has been reached", 409);
      const claimed = await Appointment.updateOne({ _id: appt._id, status: "disruption_triage", triageAction: "pending" }, { $set: { triageAction: "transferred" } });
      if (!claimed.modifiedCount) throw new AppointmentDomainError("Appointment was changed by another request", 409);

      // Determine Queue Priority:
      // When a patient already waiting at the location is transferred to Doctor B,
      // they must be placed IMMEDIATELY behind Doctor B's active consultation -> Next Up (queuePosition = 1)!
      let assignedQueuePosition = 1;
      if (isWaiting) {
        // Find all existing waiting patients for Doctor B today
        const existingWaiting = await Appointment.find({
          locationId,
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
          locationId,
          doctorId: replacementDoctorId,
          appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["checked-in", "confirmed", "pending"] },
          _id: { $ne: appt._id },
        });
        assignedQueuePosition = countWaiting + 1;
      }

      // Calculate Fee Variance & Financial Reconciliation between previous and replacement doctor
      const [prevAssignment, repAssignment] = await Promise.all([
        DoctorAssignment.findOne({ doctorId: previousDoctorId, locationId }),
        DoctorAssignment.findOne({ doctorId: replacementDoctorId, locationId }),
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
      appt.status = isWaiting ? "checked-in" : appt.paymentStatus === "pending" ? "pending_payment" : "confirmed";
      appt.feeVariance = feeVariance;
      appt.feeResolution = feeResolution;
      appt.notes = appt.notes
        ? `${appt.notes} | [PRIORITY TRANSFER: Next up for Dr. ${targetDoctor.name} (transferred from Dr. ${previousDoctorName}): ${reason || "Disruption reassignment"}]`
        : `[PRIORITY TRANSFER: Next up for Dr. ${targetDoctor.name} (transferred from Dr. ${previousDoctorName}): ${reason || "Disruption reassignment"}]`;

      await appt.save();
      await resolveAppointmentRecovery(appt, transferredByUserId, "transferred", appt.id);
      await publishAppointmentCommunication(appt, { action: "rescheduled", actorId: await communicationActor(transferredByUserId) });

      // Update corresponding Invoice doctor reference, notes, and fee waiver documentation
      const feeNote = feeVariance > 0
        ? ` | Disruption Courtesy: Original fee ₹${prevFee} honored (₹${feeVariance} difference absorbed by location)`
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
        : undefined;

      // Immutable Audit Log: APPOINTMENT_TRANSFERRED { fromDoctor, toDoctor, reason, staffId, feeVariance }
      await AuditLog.create({
        userId: auditUserId,
        organizationId: appt.organizationId || (appt.locationId as any)?.organizationId,
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

      return { appt, locationId, previousDoctorId, previousDoctorName, replacementDoctorId, targetDoctor, patientDoc, newTokenNumber };
    });
    appt.$session(null);
    // Real-time queue broadcasts for both doctors
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId: previousDoctorId },
      message: `Patient transferred to Dr. ${targetDoctor.name}`,
      timestamp: new Date().toISOString(),
    });

    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId: replacementDoctorId },
      message: `New patient transferred from Dr. ${previousDoctorName}`,
      timestamp: new Date().toISOString(),
    });

    return appt;
  },

  /**
   * Cancels an appointment due to doctor disruption and processes refund for prepaid bookings.
   */
  async cancelByDisruption(params: CancelDisruptionParams) {
    const { appointmentId, cancelledByUserId, reason } = params;
    if (cancelledByUserId === "system") throw new AppointmentDomainError("Unanswered disruption requires staff review", 409);

    let appt = await Appointment.findById(appointmentId)
      .populate("locationId", "name phone organizationId")
      .populate("doctorId", "name email")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" },
      });

    if (!appt) {
      throw new Error("Appointment not found");
    }

    requirePendingDisruption(appt);
    if (appt.status !== "disruption_triage") throw new AppointmentDomainError("Appointment is no longer awaiting a disruption response", 409);
    const previousPaymentStatus = appt.paymentStatus;
    const claimed = await withClinicalTransaction(async () => {
      const changed = await Appointment.findOneAndUpdate(
      { _id: appt!._id, status: "disruption_triage", paymentStatus: previousPaymentStatus, triageAction: "pending" },
      { $set: { status: "cancelled", triageAction: "cancelled", paymentStatus: previousPaymentStatus === "paid" ? "refund_pending" : previousPaymentStatus,
        cancellationReason: reason || "Doctor schedule disruption",
        notes: `${appt!.notes ? `${appt!.notes} | ` : ""}[Cancelled due to doctor disruption: ${reason || "Doctor unavailable"}]` } },
      { returnDocument: "after" },
    ).populate("locationId", "name phone organizationId").populate("doctorId", "name email")
      .populate({ path: "patientId", populate: { path: "userId", select: "name email phone" } });
      if (changed) {
        if (previousPaymentStatus !== 'paid') await Invoice.updateMany({ appointmentId: changed._id, organizationId: changed.organizationId, status: 'unpaid' }, { status: 'cancelled' });
        await AuditLog.create({ userId: mongoose.Types.ObjectId.isValid(cancelledByUserId) ? cancelledByUserId : undefined, organizationId: changed.organizationId, action: 'APPOINTMENT_CANCELLED', targetId: changed._id, targetModel: 'Appointment', category: 'ADMIN', details: { appointmentId: changed.id, fromDoctor: String(changed.doctorId?._id || changed.doctorId), doctorId: String(changed.doctorId?._id || changed.doctorId), locationId: String(changed.locationId?._id || changed.locationId), staffId: cancelledByUserId, refundProcessed: false, refundPending: previousPaymentStatus === 'paid', reason: reason || 'Doctor schedule disruption' } });
        await publishAppointmentCommunication(changed, { action: "cancelled", actorId: await communicationActor(cancelledByUserId) });
      }
      return changed;
    });
    if (!claimed) throw new AppointmentDomainError("Appointment was changed by another request", 409);
    appt = claimed;
    appt.$session(null);

    const patientDoc = appt.patientId as any;
    const locationId = appt.locationId?._id?.toString() || appt.locationId?.toString();
    const doctorId = appt.doctorId?._id?.toString() || appt.doctorId?.toString();
    const doctorName = (appt.doctorId as any)?.name || "Doctor";
    const locationName = (appt.locationId as any)?.name || "Location";
    const patientName = patientDoc?.name || patientDoc?.userId?.name || "Patient";
    const patientPhone = patientDoc?.phone || patientDoc?.userId?.phone;

    const auditUserId = mongoose.Types.ObjectId.isValid(cancelledByUserId)
      ? new mongoose.Types.ObjectId(cancelledByUserId)
      : undefined;

    let refundAmount = 0;
    let refundId = "";

    // If appointment is prepaid, execute refund
    if (previousPaymentStatus === "paid") {
      const invoice = await Invoice.findOne({ appointmentId: appt._id });
      const source = await onlineRefundSource(appt, invoice);
      refundAmount = source?.amount || 0;

      appt.paymentStatus = "refund_pending";

      if (source) {
        await AuditLog.create({ userId: auditUserId, organizationId: appt.organizationId || (appt.locationId as any)?.organizationId,
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

          if (invoice) {
            invoice.status = "refunded";
          }
          await withClinicalTransaction(async () => {
            if (invoice) await invoice.save();
            await appt!.save();
            await AuditLog.create({ userId: auditUserId, organizationId: appt!.organizationId, action: 'APPOINTMENT_REFUNDED', targetId: invoice?._id || appt!._id, targetModel: 'Invoice', category: 'BILLING', details: { appointmentId: appt!.id, invoiceId: invoice?.id, amount: refundAmount, refundId, staffId: cancelledByUserId } });
            await publishAppointmentCommunication(appt, { action: 'refund', actorId: await communicationActor(cancelledByUserId) });
          });
          appt.$session(null);
          invoice?.$session(null);
        } else {
          await AuditLog.create({ userId: auditUserId, organizationId: appt.organizationId, action: 'REFUND_PROVIDER_RESULT', targetId: appt._id, targetModel: 'Appointment', category: 'BILLING', details: { appointmentId: appt.id, paymentId: source.paymentId, refundId, providerStatus: refundResult?.status || 'unknown', refundProcessed: false, amount: refundAmount } });
        }
      }
    }

    // Real-time queue broadcast
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId },
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

    const { originalAppt, newAppt, locationId, doctorId, patientDoc, newTokenNumber, newAppointmentTime, timezone } = await withClinicalTransaction(async () => {
      const originalAppt = await Appointment.findById(appointmentId)
        .populate("locationId", "name phone organizationId")
        .populate("doctorId", "name email")
        .populate({
          path: "patientId",
          populate: { path: "userId", select: "name email phone" },
        });

      if (!originalAppt) {
        throw new Error("Appointment not found");
      }

      requirePendingDisruption(originalAppt);

      const locationId = originalAppt.locationId?._id?.toString() || originalAppt.locationId?.toString();
      const doctorId = targetDoctorId || originalAppt.doctorId?._id?.toString() || originalAppt.doctorId?.toString();

      const timezone = await getLocationTimezone(locationId);
      let newAppointmentTime: Date;
      try { newAppointmentTime = locationLocalTimeToDate(targetDate, targetTimeSlot || "09:00", timezone); }
      catch { throw new AppointmentDomainError("Invalid location date or time", 400); }
      const { start: startOfDay, end: endOfDay } = locationDayRange(targetDate, timezone);

      const assignment = await DoctorAssignment.findOne({ locationId, doctorId, isActive: true });
      if (!assignment || String(assignment.organizationId) !== String(originalAppt.organizationId || (originalAppt.locationId as any)?.organizationId)) {
        throw new AppointmentDomainError("Doctor is not assigned to this location", 404);
      }
      const actor = mongoose.Types.ObjectId.isValid(rescheduledByUserId) ? await User.findById(rescheduledByUserId).select("role") : null;
      await validateAppointmentAvailability({ role: actor?.role || "patient" }, {
        locationId, doctorId, appointmentTime: newAppointmentTime.toISOString(), appointmentType: originalAppt.appointmentType,
        duration: originalAppt.duration,
      }, assignment, originalAppt.id);

      // Get next token on target date
      const newTokenNumber = await nextDisruptionToken(locationId, doctorId, targetDate, startOfDay, endOfDay);
      if (assignment.maxDailyTokens && newTokenNumber > assignment.maxDailyTokens) throw new AppointmentDomainError("Doctor's daily token limit has been reached", 409);
      const claimed = await Appointment.updateOne({ _id: originalAppt._id, status: "disruption_triage", triageAction: "pending" }, { $set: { status: "cancelled", triageAction: "rescheduled" } });
      if (!claimed.modifiedCount) throw new AppointmentDomainError("Appointment was changed by another request", 409);

      if (assignment.bookingMode === "sequential_queue" && originalAppt.paymentStatus !== "pending") {
        const waiting = await Appointment.find({ locationId, doctorId, appointmentTime: { $gte: startOfDay, $lte: endOfDay },
          status: { $in: ["pending", "confirmed", "checked-in"] }, _id: { $ne: originalAppt._id } }).sort({ queuePosition: 1, tokenNumber: 1 });
        for (let index = 0; index < waiting.length; index++) {
          waiting[index].queuePosition = index + 2;
          await waiting[index].save();
        }
      }

      // Create new priority appointment
      const newAppt = await Appointment.create({
        organizationId: originalAppt.organizationId || (originalAppt.locationId as any)?.organizationId,
        locationId,
        doctorId,
        patientId: originalAppt.patientId?._id || originalAppt.patientId,
        bookedByUserId: originalAppt.bookedByUserId,
        appointmentTime: newAppointmentTime,
        appointmentType: originalAppt.appointmentType,
        status: originalAppt.paymentStatus === "pending" ? "pending_payment" : "confirmed",
        paymentStatus: originalAppt.paymentStatus, // carry forward prepaid status!
        bookingSource: originalAppt.bookingSource,
        tokenNumber: newTokenNumber,
        queuePosition: assignment.bookingMode === "sequential_queue" && originalAppt.paymentStatus !== "pending" ? 1 : newTokenNumber,
        bookingMode: assignment.bookingMode,
        duration: originalAppt.duration || 15,
        reasonForVisit: originalAppt.reasonForVisit,
        priorityRescheduledFromId: originalAppt._id,
        notes: `[Priority Rescheduled from ${locationDateKey(new Date(originalAppt.appointmentTime), timezone)}: ${reason || "Disruption"}]`,
      });

      // Mark original appointment as rescheduled
      originalAppt.status = "cancelled";
      originalAppt.triageAction = "rescheduled";
      originalAppt.cancellationReason = `Priority Rescheduled to ${targetDate}`;
      originalAppt.notes = originalAppt.notes
        ? `${originalAppt.notes} | [Rescheduled to ${targetDate} - New Appointment ID: ${newAppt._id}]`
        : `[Rescheduled to ${targetDate} - New Appointment ID: ${newAppt._id}]`;
      await originalAppt.save();
      await resolveAppointmentRecovery(originalAppt, mongoose.Types.ObjectId.isValid(rescheduledByUserId) ? rescheduledByUserId : undefined, "rescheduled", newAppt.id);
      await publishAppointmentCommunication(newAppt, { action: "rescheduled", actorId: await communicationActor(rescheduledByUserId) });

      // Carry the canonical invoice to the replacement booking, including unpaid balances.
      if (["paid", "pending", "pay_at_location"].includes(originalAppt.paymentStatus)) {
        await Invoice.updateMany(
          { appointmentId: originalAppt._id, organizationId: originalAppt.organizationId, status: { $ne: "cancelled" } },
          {
            appointmentId: newAppt._id,
            notes: `Carried forward from appointment ${originalAppt._id}`,
          }
        );
      }

      const patientDoc = originalAppt.patientId as any;
      const auditUserId = mongoose.Types.ObjectId.isValid(rescheduledByUserId)
        ? new mongoose.Types.ObjectId(rescheduledByUserId)
        : undefined;

      // Immutable Audit Log: APPOINTMENT_RESCHEDULED
      await AuditLog.create({
        userId: auditUserId,
        organizationId: originalAppt.organizationId || (originalAppt.locationId as any)?.organizationId,
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

      return { originalAppt, newAppt, locationId, doctorId, patientDoc, newTokenNumber, newAppointmentTime, timezone };
    });
    originalAppt.$session(null);
    newAppt.$session(null);
    // Real-time queue broadcast
    broadcastQueueUpdate(locationId, {
      type: "QUEUE_UPDATED",
      data: { locationId, doctorId },
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

  /** Unanswered disruption is staff review; silence never cancels or refunds care. */
  async processDisruptionTimeout(fence?: () => Promise<void>) {
    const now = new Date();
    const due: mongoose.QueryFilter<mongoose.InferSchemaType<typeof Appointment.schema>> = { status: "disruption_triage", triageAction: { $in: ["pending", "timeout_processing"] }, disruptionReviewRequiredAt: { $exists: false }, $or: [
      { disruptionReviewDueAt: { $lte: now } },
      { disruptionResponseDeadline: { $lte: now } },
      { disruptionReviewDueAt: { $exists: false }, disruptionResponseDeadline: { $exists: false }, disruptedAt: { $lte: new Date(now.getTime() - 60 * 60 * 1000) } },
    ] };
    const appointments = await Appointment.find(due).sort({ _id: 1 }).limit(100);
    let reviewRequiredCount = 0;
    for (const appointment of appointments) {
      const claimed = await withClinicalTransaction(async () => {
        if (fence) await fence();
        if (!appointment.organizationId || !await Location.exists({ _id: appointment.locationId, organizationId: appointment.organizationId, isActive: true })) return false;
        const changed = await Appointment.findOneAndUpdate({ ...due, _id: appointment._id, organizationId: appointment.organizationId }, { $set: { disruptionReviewRequiredAt: now, triageAction: "pending" }, $unset: { disruptionTimeoutClaimedAt: 1, disruptionTimeoutClaimToken: 1 } }, { returnDocument: 'after' });
        if (!changed) return false;
        const relationship = await PatientRelationship.findOne({ organizationId: changed.organizationId, patientId: changed.patientId, locationId: changed.locationId, status: 'active' }).select('ownerId').lean();
        await createCrmTask({ organizationId: String(changed.organizationId), locationId: String(changed.locationId), patientId: String(changed.patientId), appointmentId: changed.id, kind: 'crm_recovery', title: 'Review unanswered doctor disruption', dueDate: now, assignedTo: relationship?.ownerId?.toString(), dedupeKey: 'disruption-unanswered:' + changed.id + ':' + String(changed.disruptionId || 'legacy') });
        return true;
      });
      if (claimed) reviewRequiredCount++;
    }
    return { autoCancelledCount: 0, reviewRequiredCount, totalExpiredFound: appointments.length };
  },
};

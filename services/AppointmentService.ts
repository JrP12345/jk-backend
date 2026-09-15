import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { Doctor } from "../models/Doctor.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { validateSlotLockForBooking, forceReleaseSlotLock } from "./SlotLockService.ts";
import { generateClinicInvoiceNumber } from "../utilities/invoiceNumber.ts";
import { getEffectiveDoctorSchedule } from "./SlotService.ts";
import { createTrackerCapability } from "../utilities/publicTracker.ts";

export class AppointmentDomainError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AppointmentDomainError";
    this.statusCode = statusCode;
  }
}

export interface BookAppointmentInput {
  clinicId: string;
  doctorId: string;
  appointmentTime: string;
  appointmentType: "walk-in" | "online" | "reception" | "qr";
  notes?: string;
  patientId?: string;
  patientDetails?: {
    name: string;
    dob: string;
    gender: "male" | "female" | "other";
    phone?: string;
    email?: string;
    address?: string;
    allergies?: string[];
    conditions?: string[];
    medicalNotes?: string;
  };
  followUpForAppointmentId?: string;
  lockId?: string;
  reasonForVisit?: string;
  duration?: number;
  payAtClinic?: boolean;
  forceBooking?: boolean;
}

export interface BookingActor {
  id: string;
  role: string;
  organizationId?: string;
}

export class AppointmentService {
  /**
   * Orchestrates the complete appointment booking workflow:
   * 1. Doctor assignment & booking mode validation
   * 2. Slot lock acquisition & validation
   * 3. Patient identity resolution (self, dependent, existing walk-in, or new profile)
   * 4. Duplicate booking guard & time-slot collision check
   * 5. Atomic sequential daily token counter generation
   * 6. Appointment record persistence
   * 7. Auto invoice creation for consultation fees
   * 8. Audit logging & async notification dispatch
   */
  async book(actor: BookingActor, input: BookAppointmentInput, effectiveOrgId?: string) {
    let { doctorId } = input;
    const {
      clinicId,
      appointmentTime,
      appointmentType,
      notes,
      patientId,
      patientDetails,
      followUpForAppointmentId,
      lockId,
      reasonForVisit,
      duration,
      payAtClinic,
    } = input;

    if (!clinicId || !doctorId || !appointmentTime || !appointmentType) {
      throw new AppointmentDomainError("clinicId, doctorId, appointmentTime, and appointmentType are required", 400);
    }

    const orgId = effectiveOrgId || actor.organizationId;
    if (actor.role !== "root" && !orgId) {
      throw new AppointmentDomainError("Organization context is required to book an appointment", 403);
    }

    // 1. Validate Doctor Assignment
    const clinicQuery = mongoose.Types.ObjectId.isValid(clinicId)
      ? { $in: [clinicId, new mongoose.Types.ObjectId(clinicId)] }
      : clinicId;

    let assignment = await DoctorAssignment.findOne({
      doctorId: mongoose.Types.ObjectId.isValid(doctorId)
        ? { $in: [doctorId, new mongoose.Types.ObjectId(doctorId)] }
        : doctorId,
      clinicId: clinicQuery,
    });

    if (!assignment && mongoose.Types.ObjectId.isValid(doctorId)) {
      const docProfile = await Doctor.findOne({
        $or: [{ _id: doctorId }, { userId: doctorId }],
      });
      if (docProfile) {
        const candidateIds = [docProfile.userId, docProfile._id].filter(Boolean);
        assignment = await DoctorAssignment.findOne({
          doctorId: { $in: candidateIds },
          clinicId: clinicQuery,
        });
      }
    }
    if (!assignment) {
      throw new AppointmentDomainError("Doctor is not assigned to the selected clinic", 400);
    }
    doctorId = assignment.doctorId.toString();

    const requestedDate = new Date(appointmentTime);
    if (isNaN(requestedDate.getTime())) {
      throw new AppointmentDomainError("Invalid appointment time format", 400);
    }

    const now = new Date();
    const isStaffRole = ["receptionist", "admin", "doctor", "clinic_manager", "root"].includes(actor.role);
    const isWalkIn = input.appointmentType === "walk-in";

    // Guard against booking in the past (> 5 minutes buffer for network latency)
    if (requestedDate.getTime() < now.getTime() - 5 * 60 * 1000) {
      const isSameDay = requestedDate.toDateString() === now.toDateString();
      if ((!isStaffRole && !input.forceBooking && !isWalkIn) || !isSameDay) {
        throw new AppointmentDomainError("Cannot book appointments in the past", 400);
      }
    }

    // Validate Working Hours and Doctor Availability (incorporates Day Overrides)
    const effectiveSchedule = await getEffectiveDoctorSchedule(
      doctorId,
      clinicId,
      requestedDate,
      (assignment as any)?.workingHours
    );

    const isHoliday = effectiveSchedule.overrideActive && effectiveSchedule.overrideStatus === "unavailable";
    if (isHoliday) {
      if (!input.forceBooking) {
        const reason = effectiveSchedule.overrideReason ? `: ${effectiveSchedule.overrideReason}` : "";
        throw new AppointmentDomainError(`Doctor is on holiday / leave on the selected date${reason}`, 400);
      }
    } else if (!effectiveSchedule.isWorkingDay || effectiveSchedule.intervals.length === 0) {
      if (!input.forceBooking && !isStaffRole && !isWalkIn && process.env.NODE_ENV !== "test") {
        const reason = effectiveSchedule.overrideReason ? `: ${effectiveSchedule.overrideReason}` : "";
        throw new AppointmentDomainError(`Doctor is not available on the selected date${reason}`, 400);
      }
    }

    const mode = (assignment as any)?.bookingMode;
    const isSequentialQueue = mode ? mode === "sequential_queue" : true;
    const slotDuration = duration || (assignment as any)?.appointmentDuration || 15;

    // In time_slot mode: ensure requested appointment time falls within doctor's working intervals
    if (!isSequentialQueue) {
      const reqH = requestedDate.getHours();
      const reqM = requestedDate.getMinutes();
      const reqMinutes = reqH * 60 + reqM;

      const isWithinWorkingHours = effectiveSchedule.intervals.some((interval) => {
        const [startH, startM] = interval.start.split(":").map(Number);
        const [endH, endM] = interval.end.split(":").map(Number);
        const startMinutes = (startH || 0) * 60 + (startM || 0);
        const endMinutes = (endH || 0) * 60 + (endM || 0);
        return reqMinutes >= startMinutes && reqMinutes + slotDuration <= endMinutes;
      });

      if (!isWithinWorkingHours) {
        throw new AppointmentDomainError(
          `Requested appointment time is outside practitioner working hours (${effectiveSchedule.workingHoursLabel})`,
          400
        );
      }
    }

    // Smart Booking Cutoff: If booking for today, verify doctor has remaining capacity
    const isBookingToday = requestedDate.toDateString() === now.toDateString();
    if (isBookingToday) {
      const [endH, endM] = (effectiveSchedule.dayEndTime || "17:00").split(":").map(Number);
      const closingMinutes = (endH || 0) * 60 + (endM || 0);
      const currentMinutes = now.getHours() * 60 + now.getMinutes();
      const remainingOperatingMinutes = closingMinutes - currentMinutes;

      if (remainingOperatingMinutes <= 0 && !input.forceBooking && !isStaffRole && process.env.NODE_ENV !== "test") {
        throw new AppointmentDomainError(
          `Doctor's working hours have already ended for today (${effectiveSchedule.dayEndTime})`,
          400
        );
      }

      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

      // Fetch Damped Hybrid Duration
      const { getAdaptiveConsultationDuration } = await import("../controllers/queue.ts");
      const { duration: effectiveDuration } = await getAdaptiveConsultationDuration(
        clinicId,
        doctorId,
        startOfToday,
        endOfToday,
        slotDuration
      );

      const activeWaitingPatients = await Appointment.countDocuments({
        clinicId,
        doctorId,
        appointmentTime: { $gte: startOfToday, $lte: endOfToday },
        status: { $in: ["pending", "confirmed", "checked-in", "in-consultation"] }
      });

      const estimatedQueueTime = activeWaitingPatients * effectiveDuration;

      // Tiered Safety Buffer:
      // Online bookings close earlier by onlineBookingSafetyBuffer (default 30 mins)
      // Walk-in / QR admissions continue up to shift end
      const isOnlineBooking = input.appointmentType === "online";
      const safetyBuffer = isOnlineBooking ? ((assignment as any).onlineBookingSafetyBuffer ?? 30) : 0;
      const allowedOperatingMinutes = closingMinutes - safetyBuffer - currentMinutes;

      if (estimatedQueueTime + effectiveDuration > allowedOperatingMinutes && !input.forceBooking) {
        if (isOnlineBooking && estimatedQueueTime + effectiveDuration <= remainingOperatingMinutes) {
          throw new AppointmentDomainError(
            `Same-day online booking is closed for today due to queue backlog. A ${safetyBuffer}-minute safety buffer is enforced before shift end (${effectiveSchedule.dayEndTime}). Walk-in registration at the clinic may still be accepted.`,
            409
          );
        }
        throw new AppointmentDomainError(
          `Doctor capacity reached for today. Current queue backlog (${activeWaitingPatients} patients, ~${estimatedQueueTime} mins) exceeds available capacity (operating hours finish at ${effectiveSchedule.dayEndTime}).`,
          409
        );
      }
    }

    // 2. Validate Slot Lock (for time_slot mode)
    let lockValidation: { valid: boolean; message?: string; lockKey?: string } = { valid: true };
    if (!isSequentialQueue) {
      lockValidation = await validateSlotLockForBooking(
        clinicId,
        doctorId,
        appointmentTime,
        actor.id,
        lockId
      );
      if (!lockValidation.valid) {
        throw new AppointmentDomainError(lockValidation.message || "Slot is unavailable", 409);
      }
    }

    return await withTransaction(async (session) => {
      const option = session ? { session } : {};
      let finalPatientId: string;

      // 3. Identify or Create Patient Profile
      if (actor.role === "patient" || actor.role === "guest") {
        const targetPatientId = patientId;

        if (targetPatientId) {
          let isAuthorized = await FamilyRelationship.findOne(
            { userId: actor.id, patientId: targetPatientId, status: "active" },
            null,
            option
          );
          if (!isAuthorized) {
            const selfPatient = await Patient.findById(targetPatientId, null, option).setOptions({ bypassTenantFilter: true });
            if (
              selfPatient &&
              (String(selfPatient.userId || "") === String(actor.id) ||
                String(selfPatient._id || "") === String(actor.id))
            ) {
              isAuthorized = true as any;
            }
          }
          if (!isAuthorized) {
            throw new AppointmentDomainError("Unauthorized: You do not have permission to book for this patient", 403);
          }
          finalPatientId = targetPatientId;
        } else {
          // Default to self patient profile
          let selfRel = await FamilyRelationship.findOne({ userId: actor.id, relationship: "self", status: "active" }, null, option);
          let patient = selfRel
            ? await Patient.findById(selfRel.patientId, null, option).setOptions({ bypassTenantFilter: true })
            : await Patient.findOne({ userId: actor.id }, null, option).setOptions({ bypassTenantFilter: true });

          if (!patient) {
            const loggedUser = await User.findById(actor.id, null, option);
            patient = await createWithSession(Patient, {
              userId: loggedUser?._id || actor.id,
              name: loggedUser?.name || "Patient",
              phone: loggedUser?.phone || null,
              email: loggedUser?.email || null,
              accountType: "self",
              createdBy: actor.id,
              organizationId: orgId,
            }, session);

            await createWithSession(FamilyRelationship, {
              userId: actor.id,
              patientId: patient!._id,
              relationship: "self",
              status: "active",
            }, session);
          }

          // Universal patient: associate with organization if not already set, and ensure OrgMember
          if (!patient!.organizationId && orgId) {
            patient!.organizationId = orgId as any;
            await patient!.save(option);
          }
          if (patient!.userId && orgId) {
            const memberExists = await OrgMember.findOne({ userId: patient!.userId, organizationId: orgId }, null, option);
            if (!memberExists) {
              await createWithSession(OrgMember, { userId: patient!.userId, organizationId: orgId, role: "patient" }, session);
            }
          }
          finalPatientId = patient!.id;
        }
      } else {
        // Staff / Receptionist / Doctor booking
        if (patientId) {
          const patient = await Patient.findById(patientId, null, option).setOptions({ bypassTenantFilter: true });
          if (!patient) throw new AppointmentDomainError("Patient profile not found", 404);
          if (patient.organizationId && orgId && patient.organizationId.toString() !== orgId.toString()) {
            throw new AppointmentDomainError("Patient profile not found", 404);
          }
          if (!patient.organizationId && orgId) {
            patient.organizationId = orgId as any;
            await patient.save(option);
          }
          finalPatientId = patient.id;

          if (orgId && patient.userId) {
            const memberExists = await OrgMember.findOne({ userId: patient.userId, organizationId: orgId }, null, option);
            if (!memberExists) {
              await createWithSession(OrgMember, { userId: patient.userId, organizationId: orgId, role: "patient" }, session);
            }
          }
        } else if (patientDetails) {
          const { name, dob, gender, phone, email, address, allergies, conditions, medicalNotes } = patientDetails;
          if (!name || !dob || !gender) {
            throw new AppointmentDomainError("name, dob, and gender are required for new patient registration", 400);
          }

          const patientProfile = await createWithSession(Patient, {
            name: name.trim(),
            phone: phone?.trim() || null,
            email: email?.trim().toLowerCase() || null,
            accountType: "walkin",
            createdBy: actor.id,
            organizationId: orgId,
            personalVaultId: `pvt_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
            dob: new Date(dob),
            gender,
            address: address || null,
            allergies: allergies || [],
            conditions: conditions || [],
            medicalNotes: medicalNotes || null
          }, session);

          finalPatientId = patientProfile.id;
        } else {
          throw new AppointmentDomainError("Either patientId or patientDetails is required for staff booking", 400);
        }
      }

      // 4. Duplicate active appointment guard
      const requestedDate = new Date(appointmentTime);
      const existingDuplicate = await Appointment.findOne({
        patientId: finalPatientId,
        doctorId,
        clinicId,
        appointmentTime: requestedDate,
        status: { $in: ["pending", "pending_payment", "confirmed", "checked-in", "in-consultation"] }
      }, null, option);
      if (existingDuplicate) {
        throw new AppointmentDomainError("An active appointment for this patient with this practitioner at the selected time already exists", 409);
      }

      // 5. Time-slot collision guard
      const currentBookingMode = (assignment as any)?.bookingMode || "sequential_queue";
      if (currentBookingMode === "time_slot") {
        const slotCollision = await Appointment.findOne({
          clinicId,
          doctorId,
          appointmentTime: requestedDate,
          bookingMode: "time_slot",
          status: { $in: ["pending", "pending_payment", "confirmed", "checked-in", "in-consultation"] }
        }, null, option);
        if (slotCollision) {
          throw new AppointmentDomainError("This consultation time slot has already been booked by another patient", 409);
        }
      }

      // 6. Generate Atomic Sequential Daily Token
      const dateStr = requestedDate.toISOString().slice(0, 10);
      const counterKey = `token_${clinicId}_${doctorId}_${dateStr}`;
      const tokenNumber = await getNextAtomicSequence(counterKey, session);

      const maxTokens = (assignment as any)?.maxDailyTokens;
      if (maxTokens && tokenNumber > maxTokens) {
        throw new AppointmentDomainError(`Daily token limit of ${maxTokens} reached for this practitioner.`, 400);
      }

      const queuePosition = tokenNumber;
      const initialStatus = actor.role === "patient" ? "pending" : "confirmed";
      const slotDuration = duration || (assignment as any)?.appointmentDuration || 15;
      const visitReason = reasonForVisit || (followUpForAppointmentId ? "follow_up" : "new_consultation");

      const assignmentFeeType = (assignment as any)?.feeType || "fixed";
      let isPaymentRequired = (assignment as any)?.paymentRequired === true;
      let initialPaymentStatus = isPaymentRequired ? "pending" : (payAtClinic ? "pay_at_clinic" : "not_required");
      let apptPaymentAmount = (assignment as any)?.fees ?? 500;

      if (assignmentFeeType === "post_consultation") {
        isPaymentRequired = false;
        initialPaymentStatus = "pay_at_clinic";
        apptPaymentAmount = 0;
      } else if (assignmentFeeType === "free") {
        isPaymentRequired = false;
        initialPaymentStatus = "not_required";
        apptPaymentAmount = 0;
      }

      const trackerCapability = createTrackerCapability();
      const appointment = await createWithSession(Appointment, {
        organizationId: orgId || null,
        clinicId,
        doctorId,
        patientId: finalPatientId,
        bookedByUserId: actor.id,
        trackerTokenHash: trackerCapability.hash,
        trackerTokenExpiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        appointmentTime: requestedDate,
        appointmentType,
        status: isPaymentRequired ? "pending_payment" : initialStatus,
        paymentStatus: initialPaymentStatus,
        feeType: assignmentFeeType,
        paymentAmount: apptPaymentAmount,
        bookingSource: actor.role === "patient" ? "patient_portal" : "staff",
        tokenNumber,
        queuePosition,
        bookingMode: currentBookingMode,
        duration: slotDuration,
        reasonForVisit: visitReason,
        notes: notes || null
      }, session);

      // 7. Follow-up link
      if (followUpForAppointmentId) {
        if (!mongoose.Types.ObjectId.isValid(followUpForAppointmentId)) {
          throw new AppointmentDomainError("Invalid followUpForAppointmentId", 400);
        }
        const parentAppt = await Appointment.findOne({
          _id: followUpForAppointmentId,
          patientId: finalPatientId
        }, null, option);
        if (parentAppt && parentAppt.status !== "completed") {
          parentAppt.status = "completed";
          await parentAppt.save(option);
        }
      }

      // 8. Auto Invoice for consultation fees (with 7-Day Courtesy Follow-Up Rule)
      // Only auto-invoice fixed fee doctors at booking time. Post-consultation billing happens post-encounter.
      if (assignmentFeeType === "fixed" && (assignment as any)?.fees && (assignment as any).fees > 0) {
        const doctorUser = await User.findById(doctorId, null, option);
        const doctorName = doctorUser?.name ? `Dr. ${doctorUser.name}` : `Dr. ${doctorId}`;
        const invoiceNumber = await generateClinicInvoiceNumber(clinicId, requestedDate.getFullYear());

        let is7DayCourtesyFollowUp = false;
        let courtesyReason = "";

        if (followUpForAppointmentId) {
          const parent = await Appointment.findById(followUpForAppointmentId, null, option);
          if (parent) {
            const parentDate = new Date(parent.appointmentTime);
            const daysDiff = (requestedDate.getTime() - parentDate.getTime()) / (1000 * 60 * 60 * 24);
            if (daysDiff >= 0 && daysDiff <= 7) {
              is7DayCourtesyFollowUp = true;
              courtesyReason = `7-Day Follow-Up Courtesy Waiver (Parent Token #${parent.tokenNumber})`;
            }
          }
        } else if (visitReason === "follow_up") {
          const sevenDaysAgo = new Date(requestedDate);
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
          const recentAppt = await Appointment.findOne({
            patientId: finalPatientId,
            clinicId,
            doctorId,
            status: "completed",
            appointmentTime: { $gte: sevenDaysAgo, $lte: requestedDate }
          }, null, option);

          if (recentAppt) {
            is7DayCourtesyFollowUp = true;
            courtesyReason = `7-Day Follow-Up Courtesy Waiver (Recent Token #${recentAppt.tokenNumber})`;
          }
        }

        if (is7DayCourtesyFollowUp) {
          await createWithSession(Invoice, {
            invoiceNumber,
            organizationId: orgId || null,
            patientId: finalPatientId,
            appointmentId: appointment._id,
            clinicId,
            doctorId,
            items: [
              {
                description: `Consultation Fee - ${doctorName} (${courtesyReason})`,
                amount: 0,
                quantity: 1
              }
            ],
            subtotal: 0,
            tax: 0,
            discount: 0,
            totalAmount: 0,
            status: "paid",
            paymentMethod: "courtesy_waiver",
            paymentDate: new Date(),
          }, session);

          appointment.paymentStatus = "not_required";
          await appointment.save(option);
        } else {
          await createWithSession(Invoice, {
            invoiceNumber,
            organizationId: orgId || null,
            patientId: finalPatientId,
            appointmentId: appointment._id,
            clinicId,
            doctorId,
            items: [
              {
                description: `Consultation Fee - ${doctorName}`,
                amount: (assignment as any).fees,
                quantity: 1
              }
            ],
            subtotal: (assignment as any).fees,
            tax: 0,
            discount: 0,
            totalAmount: (assignment as any).fees,
            status: "unpaid"
          }, session);
        }
      }

      // 9. Audit Log
      await createWithSession(AuditLog, {
        userId: actor.id,
        organizationId: orgId || undefined,
        action: "APPOINTMENT_CREATE",
        targetId: appointment._id,
        targetModel: "Appointment",
        details: { tokenNumber, appointmentTime, clinicId, doctorId }
      }, session);

      // 10. Release slot lock
      if (lockValidation.lockKey) {
        forceReleaseSlotLock(lockValidation.lockKey).catch((err) =>
          console.error("Slot lock release failed (non-critical):", err)
        );
      }

      // 11. Async Notification
      sendBookingNotification(appointment._id, "booked", trackerCapability.token).catch((err) =>
        console.error("Notification dispatch failed:", err)
      );

      return {
        id: appointment.id,
        clinicId,
        doctorId,
        patientId: finalPatientId,
        appointmentTime: appointment.appointmentTime,
        appointmentType: appointment.appointmentType,
        status: appointment.status,
        paymentStatus: appointment.paymentStatus,
        bookingMode: appointment.bookingMode,
        tokenNumber: appointment.tokenNumber,
        queuePosition: appointment.queuePosition,
        duration: appointment.duration,
        reasonForVisit: appointment.reasonForVisit,
        notes: appointment.notes,
        trackerToken: trackerCapability.token,
        createdAt: appointment.createdAt,
      };
    });
  }
}

export const appointmentService = new AppointmentService();

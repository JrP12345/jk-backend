import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import {
  acquireSlotLock,
  releaseSlotLock,
  checkSlotLock,
  validateSlotLockForBooking,
  forceReleaseSlotLock,
} from "../services/SlotLockService.ts";
import { checkClinicAccess, getRequestClinicIds } from "../utilities/tenant.ts";
import { getNextAtomicSequence } from "../models/Counter.ts";

async function ensureAppointmentClinicAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  clinicId: unknown,
): Promise<boolean> {
  const check = await checkClinicAccess(req, clinicId);
  if (!check.allowed) {
    reply.code(check.statusCode).send(errorResponse(check.message));
    return false;
  }
  return true;
}

export async function bookAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    let orgId = req.user?.organization_id;

    const {
      clinicId, doctorId, appointmentTime, appointmentType, notes, patientId, patientDetails, followUpForAppointmentId, lockId
    } = req.body as {
      clinicId: string;
      doctorId: string;
      appointmentTime: string;
      appointmentType: "walk-in" | "online" | "reception" | "qr";
      notes?: string;
      patientId?: string; // Optional for staff booking existing patients
      patientDetails?: {  // Optional for staff booking new patients
        name: string;
        dob: string;
        gender: "male" | "female" | "other";
        phone?: string;
        email?: string;
        password: string;
        address?: string;
        allergies?: string[];
        conditions?: string[];
        medicalNotes?: string;
      };
      followUpForAppointmentId?: string;
      lockId?: string; // Optional: slot lock ID from prior lock acquisition
    };

    if (!clinicId || !doctorId || !appointmentTime || !appointmentType) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, appointmentTime, and appointmentType are required"));
    }

    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) {
      return reply.code(clinicAccess.statusCode).send(errorResponse(clinicAccess.message));
    }
    if (!orgId && clinicAccess.organizationId) orgId = clinicAccess.organizationId;

    if (userRole !== "root" && !orgId) {
      return reply.code(403).send(errorResponse("Organization context is required to book an appointment"));
    }

    // Validate Doctor Assignment at Clinic
    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId });
    if (!assignment) {
      return reply.code(400).send(errorResponse("Doctor is not assigned to the selected clinic"));
    }

    const mode = (assignment as any)?.bookingMode;
    const isSequentialQueue = mode ? mode === "sequential_queue" : true;

    // Validate Slot Lock — prevent double-booking (only for time_slot mode)
    let lockValidation: { valid: boolean; message?: string; lockKey?: string } = { valid: true };
    if (!isSequentialQueue) {
      lockValidation = await validateSlotLockForBooking(
        clinicId, doctorId, appointmentTime, userId, lockId
      );
      if (!lockValidation.valid) {
        return reply.code(409).send(errorResponse(lockValidation.message || "Slot is unavailable"));
      }
    }

    return await withTransaction(async (session) => {
      const option = session ? { session } : {};
      let finalPatientId: string;      // 1. Identify or Create Patient Profile
      if (userRole === "patient") {
        const targetPatientId = patientId || (req.body as any).forPatientId;
        
        if (targetPatientId) {
          // Verify authorization via FamilyRelationship
          const isAuthorized = await FamilyRelationship.findOne(
            { userId, patientId: targetPatientId, status: "active" },
            null,
            option
          );
          if (!isAuthorized) {
            return reply.code(403).send(errorResponse("Unauthorized: You do not have permission to book for this patient"));
          }
          finalPatientId = targetPatientId;
        } else {
          // Default to self patient profile
          let selfRel = await FamilyRelationship.findOne({ userId, relationship: "self", status: "active" }, null, option);
          let patient = selfRel ? await Patient.findById(selfRel.patientId, null, option) : await Patient.findOne({ userId }, null, option);

          if (!patient) {
            const loggedUser = await User.findById(userId, null, option);
            patient = await createWithSession(Patient, {
              userId: loggedUser?._id || userId,
              name: loggedUser?.name || "Patient",
              phone: loggedUser?.phone || null,
              email: loggedUser?.email || null,
              accountType: "self",
              createdBy: userId,
              organizationId: orgId,
            }, session);

            await createWithSession(FamilyRelationship, {
              userId,
              patientId: patient!._id,
              relationship: "self",
              status: "active",
            }, session);
          }

          if (patient!.organizationId && patient!.organizationId.toString() !== orgId) {
            return reply.code(403).send(errorResponse("Patient is not associated with the selected organization"));
          }
          if (!patient!.organizationId && orgId) {
            patient!.organizationId = orgId as any;
            await patient!.save(option);
            if (patient!.userId) {
              await createWithSession(OrgMember, { userId: patient!.userId, organizationId: orgId, role: "patient" }, session);
            }
          }
          finalPatientId = patient!.id;
        }
      } else {
        // Staff / Receptionist / Doctor booking
        if (patientId) {
          const patient = await Patient.findById(patientId, null, option);
          if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
          if (
            userRole !== "root" &&
            orgId &&
            patient.organizationId &&
            patient.organizationId.toString() !== orgId
          ) {
            return reply.code(404).send(errorResponse("Patient not found"));
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
            return reply.code(400).send(errorResponse("name, dob, and gender are required for new patient registration"));
          }

          const patientProfile = await createWithSession(Patient, {
            name: name.trim(),
            phone: phone?.trim() || null,
            email: email?.trim().toLowerCase() || null,
            accountType: "walkin",
            createdBy: userId,
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
          return reply.code(400).send(errorResponse("Either patientId or patientDetails is required for staff booking"));
        }
      }

      // 1b. Duplicate active appointment guard
      const requestedDate = new Date(appointmentTime);
      const existingDuplicate = await Appointment.findOne({
        patientId: finalPatientId,
        doctorId,
        clinicId,
        appointmentTime: requestedDate,
        status: { $in: ["pending", "pending_payment", "confirmed", "checked-in", "in-consultation"] }
      }, null, option);
      if (existingDuplicate) {
        return reply.code(409).send(errorResponse("An active appointment for this patient with this practitioner at the selected time already exists"));
      }

      // 2. Generate Atomic Sequential Daily Token Number for Doctor + Clinic
      const dateStr = requestedDate.toISOString().slice(0, 10);
      const counterKey = `token_${clinicId}_${doctorId}_${dateStr}`;
      const tokenNumber = await getNextAtomicSequence(counterKey, session);

      const maxTokens = (assignment as any)?.maxDailyTokens;
      if (maxTokens && tokenNumber > maxTokens) {
        return reply.code(400).send(errorResponse(`Daily token limit of ${maxTokens} reached for this practitioner.`));
      }

      const queuePosition = tokenNumber;

      const initialStatus = userRole === "patient" ? "pending" : "confirmed";
      const slotDuration = (req.body as any).duration || assignment?.appointmentDuration || 15;
      const visitReason = (req.body as any).reasonForVisit || (followUpForAppointmentId ? "follow_up" : "new_consultation");
      const currentBookingMode = (assignment as any)?.bookingMode || "sequential_queue";

      // 3. Create Appointment Document
      const isPaymentRequired = (assignment as any)?.paymentRequired === true;
      const initialPaymentStatus = isPaymentRequired ? "pending" : ((req.body as any).payAtClinic ? "pay_at_clinic" : "not_required");

      const appointment = await createWithSession(Appointment, {
        organizationId: orgId || clinicAccess.organizationId || null,
        clinicId,
        doctorId,
        patientId: finalPatientId,
        bookedByUserId: userId,
        appointmentTime: requestedDate,
        appointmentType,
        status: isPaymentRequired ? "pending_payment" : initialStatus,
        paymentStatus: initialPaymentStatus,
        bookingSource: userRole === "patient" ? "patient_portal" : "staff",
        tokenNumber,
        queuePosition,
        bookingMode: currentBookingMode,
        duration: slotDuration,
        reasonForVisit: visitReason,
        notes: notes || null
      }, session);

      // 4. Optionally handle Follow-Up link with validation
      if (followUpForAppointmentId) {
        if (!mongoose.Types.ObjectId.isValid(followUpForAppointmentId)) {
          return reply.code(400).send(errorResponse("Invalid followUpForAppointmentId"));
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

      // 5. Automatically generate Consultation Fee Invoice
      if (assignment?.fees && assignment.fees > 0) {
        const doctorUser = await User.findById(doctorId, null, option);
        const doctorName = doctorUser?.name ? `Dr. ${doctorUser.name}` : `Dr. ${doctorId}`;
        const { generateClinicInvoiceNumber } = await import("../utilities/invoiceNumber.ts");
        const invoiceNumber = await generateClinicInvoiceNumber(clinicId, requestedDate.getFullYear());

        await createWithSession(Invoice, {
          invoiceNumber,
          organizationId: orgId || clinicAccess.organizationId || null,
          patientId: finalPatientId,
          appointmentId: appointment._id,
          clinicId,
          doctorId,
          items: [
            {
              description: `Consultation Fee - ${doctorName}`,
              amount: assignment.fees,
              quantity: 1
            }
          ],
          subtotal: assignment.fees,
          tax: 0,
          discount: 0,
          totalAmount: assignment.fees,
          status: "unpaid"
        }, session);
      }

      // 6. Audit Log with Organization Context
      await createWithSession(AuditLog, {
        userId,
        organizationId: orgId || clinicAccess.organizationId || undefined,
        action: "APPOINTMENT_CREATE",
        targetId: appointment._id,
        targetModel: "Appointment",
        details: { tokenNumber, appointmentTime, clinicId, doctorId }
      }, session);

      // 7. Release Slot Lock (if one was held)
      if (lockValidation.lockKey) {
        forceReleaseSlotLock(lockValidation.lockKey).catch((err) =>
          console.error("Slot lock release failed (non-critical):", err)
        );
      }

      // 8. Async Notification Dispatch
      sendBookingNotification(appointment._id, "booked").catch((err) => console.error("Notification dispatch failed:", err));

      return reply.code(201).send(
        successResponse(
          {
            id: appointment.id,
            clinicId,
            doctorId,
            patientId: finalPatientId,
            appointmentTime: appointment.appointmentTime,
            appointmentType: appointment.appointmentType,
            status: appointment.status,
            tokenNumber: appointment.tokenNumber,
            queuePosition: appointment.queuePosition,
            notes: appointment.notes
          },
          "Appointment booked successfully"
        )
      );
    });
  } catch (err) {
    console.error("bookAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Appointments List (Filtered by Role) ───────────────────
export async function getAppointments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const orgId = req.user?.organization_id;
    const { clinicId, doctorId, status, date, startDate, endDate, page, limit } = req.query as any;

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const filter: any = {};

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
      filter.patientId = patient._id;
    } else if (userRole === "doctor") {
      filter.doctorId = userId;
    }

    if (clinicId) {
      if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;
      filter.clinicId = clinicId;
    } else if (orgId && userRole !== "patient") {
      // Limit to clinics in requesting user's organization
      const clinicIds = await getRequestClinicIds(req);
      filter.clinicId = { $in: clinicIds };
    }

    if (doctorId && userRole !== "doctor") filter.doctorId = doctorId;
    if (status) filter.status = status;

    if (startDate || endDate) {
      filter.appointmentTime = {};
      if (startDate) {
        const sDate = new Date(startDate);
        filter.appointmentTime.$gte = new Date(sDate.getFullYear(), sDate.getMonth(), sDate.getDate(), 0, 0, 0, 0);
      }
      if (endDate) {
        const eDate = new Date(endDate);
        filter.appointmentTime.$lte = new Date(eDate.getFullYear(), eDate.getMonth(), eDate.getDate(), 23, 59, 59, 999);
      }
    } else if (date) {
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
      const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999);
      filter.appointmentTime = { $gte: startOfDay, $lte: endOfDay };
    }

    const totalCount = await Appointment.countDocuments(filter);
    const totalPages = Math.ceil(totalCount / pageSize);

    const appointments = await Appointment.find(filter)
      .populate("clinicId", "name city address")
      .populate("doctorId", "name specialization fees")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      })
      .sort({ appointmentTime: 1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });

    return reply.code(200).send(successResponse(appointments));
  } catch (err) {
    console.error("getAppointments error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Update Appointment Status ──────────────────────────────────
export async function updateAppointmentStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { status, notes } = req.body as { status: string; notes?: string };

    if (!status) return reply.code(400).send(errorResponse("status is required"));

    const allowedStatuses = ["pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show"];
    if (!allowedStatuses.includes(status)) {
      return reply.code(400).send(errorResponse("Invalid status value"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    appointment.status = status as any;
    if (notes) appointment.notes = notes;
    await appointment.save();

    if (status === "in-consultation") {
      const { Encounter } = await import("../models/Encounter.ts");
      const existingEncounter = await Encounter.findOne({ appointmentId: appointment._id });
      if (!existingEncounter) {
        await Encounter.create({
          organizationId: (appointment as any).organizationId,
          clinicId: appointment.clinicId,
          appointmentId: appointment._id,
          patientId: appointment.patientId,
          doctorId: appointment.doctorId,
          encounterType: appointment.appointmentType === "online" ? "telehealth" : "opd",
          status: "in_progress",
          startedAt: new Date(),
        });
      }
    }

    if (status === "cancelled") {
      sendBookingNotification(appointment._id, "cancelled").catch((err) => console.error("Cancellation notification dispatch failed:", err));
      await Invoice.updateMany({ appointmentId: appointment._id, status: "unpaid" }, { status: "cancelled" });
    }

    await AuditLog.create({
      userId: req.user!.id,
      action: "APPOINTMENT_STATUS_UPDATE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { status, notes }
    });

    return reply.code(200).send(successResponse(appointment, "Appointment status updated successfully"));
  } catch (err) {
    console.error("updateAppointmentStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Reschedule Appointment ────────────────────────────────────
export async function rescheduleAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user!.id;
    const { newTime, reason, lockId } = req.body as {
      newTime: string;
      reason?: string;
      lockId?: string;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    if (!newTime || isNaN(new Date(newTime).getTime())) {
      return reply.code(400).send(errorResponse("Valid newTime is required"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    if (appointment.status === "completed" || appointment.status === "cancelled") {
      return reply.code(400).send(errorResponse(`Cannot reschedule an appointment that is already ${appointment.status}`));
    }

    const newDateObj = new Date(newTime);
    if (newDateObj < new Date()) {
      return reply.code(400).send(errorResponse("Cannot reschedule an appointment to a past time"));
    }

    // Validate slot lock anti-double booking (only in time_slot mode)
    const rescheduleAssignment = await DoctorAssignment.findOne({ doctorId: appointment.doctorId, clinicId: appointment.clinicId, isActive: true });
    const rescheduleMode = (rescheduleAssignment as any)?.bookingMode;
    const rescheduleIsQueue = rescheduleMode ? rescheduleMode === "sequential_queue" : true;
    let lockValidation: { valid: boolean; message?: string; lockKey?: string } = { valid: true };
    if (!rescheduleIsQueue) {
      lockValidation = await validateSlotLockForBooking(
        appointment.clinicId.toString(),
        appointment.doctorId.toString(),
        newTime,
        userId,
        lockId
      );
      if (!lockValidation.valid) {
        return reply.code(409).send(errorResponse(lockValidation.message ?? "Slot is unavailable"));
      }
    }

    const oldTimeStr = new Date(appointment.appointmentTime).toISOString();

    // Recalculate atomic daily token number & queue position for the new date
    const newDateStr = newDateObj.toISOString().slice(0, 10);
    const counterKey = `token_${appointment.clinicId}_${appointment.doctorId}_${newDateStr}`;
    const tokenNumber = await getNextAtomicSequence(counterKey);

    appointment.appointmentTime = newDateObj;
    appointment.tokenNumber = tokenNumber;
    appointment.queuePosition = tokenNumber;
    appointment.status = "confirmed";
    if (reason) {
      appointment.notes = appointment.notes
        ? `${appointment.notes}\n[Rescheduled from ${oldTimeStr}: ${reason}]`
        : `[Rescheduled from ${oldTimeStr}: ${reason}]`;
    }
    await appointment.save();

    if (lockValidation.lockKey) {
      forceReleaseSlotLock(lockValidation.lockKey).catch(() => {});
    }

    sendBookingNotification(appointment._id, "rescheduled").catch(() => {});

    await AuditLog.create({
      userId,
      organizationId: appointment.organizationId || undefined,
      action: "APPOINTMENT_RESCHEDULE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { oldTime: oldTimeStr, newTime, reason }
    });

    return reply.code(200).send(successResponse(appointment, `Appointment successfully rescheduled to ${newDateObj.toISOString()}`));
  } catch (err) {
    console.error("rescheduleAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Doctor Time Slot Availability ─────────────────────────
export async function getDoctorSlots(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { doctorId } = req.params as { doctorId: string };
    const { clinicId, date } = req.query as { clinicId: string; date: string };

    if (!doctorId || !clinicId || !date) {
      return reply.code(400).send(errorResponse("doctorId, clinicId, and date (YYYY-MM-DD) are required"));
    }

    if (req.user && !(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const { getDoctorAvailableSlots } = await import("../services/SlotService.ts");
    const result = await getDoctorAvailableSlots(doctorId, clinicId, date, req.user?.id);

    return reply.code(200).send(successResponse(result));
  } catch (err: any) {
    console.error("getDoctorSlots error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── Patient Self-Service Appointment Cancellation ─────────────
export async function cancelAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { reason } = req.body as { reason?: string };

    const appointment = await Appointment.findById(id);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    // Check IDOR / Patient ownership for cancellation
    const userRole = req.user!.role;
    const userId = req.user!.id;
    if (userRole === "patient") {
      const selfPatient = await Patient.findOne({
        $or: [
          { userId },
          ...(mongoose.Types.ObjectId.isValid(userId) ? [{ userId: new mongoose.Types.ObjectId(userId) }] : [])
        ]
      });
      const familyRels = await FamilyRelationship.find({ userId, status: "active" }).select("patientId").lean();
      const allowedPatientIds = [
        ...(selfPatient ? [selfPatient._id.toString()] : []),
        ...familyRels.map((r) => r.patientId.toString())
      ];
      const isBookedByUser = appointment.bookedByUserId && appointment.bookedByUserId.toString() === userId;
      if (!isBookedByUser && !allowedPatientIds.includes(appointment.patientId.toString())) {
        return reply.code(403).send(errorResponse("Forbidden: You do not have permission to cancel this appointment"));
      }
    }

    if (appointment.status === "completed" || appointment.status === "cancelled") {
      return reply.code(400).send(errorResponse(`Cannot cancel appointment already in '${appointment.status}' status`));
    }

    appointment.status = "cancelled";
    if (reason) appointment.notes = `Cancelled by patient: ${reason}`;
    await appointment.save();

    sendBookingNotification(appointment._id, "cancelled").catch((err) => console.error("Cancellation notification failed:", err));

    await AuditLog.create({
      userId: req.user!.id,
      organizationId: appointment.organizationId || undefined,
      action: "PATIENT_CANCEL_APPOINTMENT",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { reason: reason || "Self-service cancellation" }
    });

    return reply.code(200).send(successResponse(appointment, "Appointment cancelled successfully"));
  } catch (err) {
    console.error("cancelAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Single Appointment by ID ─────────────────────────────
export async function getAppointmentById(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const appointment = await Appointment.findById(id)
      .populate("clinicId", "name city address")
      .populate("doctorId", "name specialization fees email phone")
      .populate({
        path: "patientId",
        populate: { path: "userId", select: "name email phone" }
      });

    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, appointment.clinicId))) return;

    return reply.code(200).send(successResponse(appointment));
  } catch (err) {
    console.error("getAppointmentById error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Acquire Lock ───────────────────────────────────
export async function lockSlot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { clinicId, doctorId, slotTime } = req.body as {
      clinicId: string;
      doctorId: string;
      slotTime: string;
    };

    if (!clinicId || !doctorId || !slotTime) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, and slotTime are required"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const result = await acquireSlotLock(clinicId, doctorId, slotTime, userId);

    if (!result.success) {
      return reply.code(409).send(errorResponse(result.message, { heldBy: result.heldBy }));
    }

    return reply.code(200).send(
      successResponse(
        {
          lockId: result.lockId,
          lockKey: result.lockKey,
          expiresInSeconds: result.expiresInSeconds,
        },
        result.message
      )
    );
  } catch (err) {
    console.error("lockSlot error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Release Lock ──────────────────────────────────
export async function unlockSlot(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { clinicId, doctorId, slotTime, lockId } = req.body as {
      clinicId: string;
      doctorId: string;
      slotTime: string;
      lockId: string;
    };

    if (!clinicId || !doctorId || !slotTime || !lockId) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, slotTime, and lockId are required"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const result = await releaseSlotLock(clinicId, doctorId, slotTime, userId, lockId);

    if (!result.success) {
      return reply.code(403).send(errorResponse(result.message));
    }

    return reply.code(200).send(successResponse(null, result.message));
  } catch (err) {
    console.error("unlockSlot error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Slot Lock: Check Lock Status ─────────────────────────────
export async function getSlotLockStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, slotTime } = req.query as {
      clinicId: string;
      doctorId: string;
      slotTime: string;
    };

    if (!clinicId || !doctorId || !slotTime) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, and slotTime are required"));
    }

    if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

    const info = await checkSlotLock(clinicId, doctorId, slotTime);

    return reply.code(200).send(
      successResponse({
        isLocked: info.isLocked,
        heldByUserId: info.heldByUserId || null,
        ttlSeconds: info.ttlSeconds || 0,
      })
    );
  } catch (err) {
    console.error("getSlotLockStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Clinic } from "../models/Clinic.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Consent } from "../models/Consent.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { validatePasswordStrength } from "../middleware/auth.ts";
import {
  acquireSlotLock,
  releaseSlotLock,
  checkSlotLock,
  validateSlotLockForBooking,
  forceReleaseSlotLock,
} from "../services/SlotLockService.ts";
import { checkClinicAccess, getRequestClinicIds } from "../utilities/tenant.ts";

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

    if (userRole !== "patient" && userRole !== "admin" && userRole !== "receptionist" && userRole !== "root" && userRole !== "doctor") {
      return reply.code(403).send(errorResponse("Forbidden: role cannot book appointments"));
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

    // Validate Slot Lock — prevent double-booking
    const lockValidation = await validateSlotLockForBooking(
      clinicId, doctorId, appointmentTime, userId, lockId
    );
    if (!lockValidation.valid) {
      return reply.code(409).send(errorResponse(lockValidation.message));
    }

    return await withTransaction(async (session) => {
      const option = session ? { session } : {};
      let finalPatientId: string;

      // 1. Identify or Create Patient Profile
      if (userRole === "patient") {
        const patient = await Patient.findOne({ userId }, null, option);
        if (!patient) {
          return reply.code(404).send(errorResponse("Patient profile not found for your account"));
        }
        if (patient.organizationId && patient.organizationId.toString() !== orgId) {
          return reply.code(403).send(errorResponse("Patient is not associated with the selected organization"));
        }
        if (!patient.organizationId && orgId) {
          patient.organizationId = orgId as any;
          await patient.save(option);
          await createWithSession(OrgMember, { userId: patient.userId, organizationId: orgId, role: "patient" }, session);
        }
        finalPatientId = patient.id;
      } else {
        // Staff booking
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

          // Ensure Patient is linked to OrgMember if not already
          if (orgId) {
            const memberExists = await OrgMember.findOne({ userId: patient.userId, organizationId: orgId }, null, option);
            if (!memberExists) {
              await createWithSession(OrgMember, { userId: patient.userId, organizationId: orgId, role: "patient" }, session);
            }
          }
        } else if (patientDetails) {
          const { name, dob, gender, phone, email, password, address, allergies, conditions, medicalNotes } = patientDetails;
          if (!name || !dob || !gender || !email?.trim() || !password) {
            return reply.code(400).send(errorResponse("name, dob, gender, email, and password are required for new patient registration"));
          }
          const strength = validatePasswordStrength(password);
          if (!strength.valid) {
            return reply.code(400).send(errorResponse(strength.reason || "Patient password does not meet complexity requirements"));
          }

          const finalEmail = email.trim().toLowerCase();
          
          const emailExists = await User.findOne({ email: finalEmail }, null, option);
          if (emailExists) {
            return reply.code(409).send(errorResponse("Email already registered"));
          }

          const hashedPassword = await bcrypt.hash(password, 10);

          const newPatientUser = await createWithSession(User, {
            name,
            email: finalEmail,
            password: hashedPassword,
            phone: phone || null,
            role: "patient"
          }, session);

          const patientProfile = await createWithSession(Patient, {
            userId: newPatientUser._id,
            organizationId: orgId,
            personalVaultId: `pvt_${newPatientUser._id.toString()}`,
            dob: new Date(dob),
            gender,
            address: address || null,
            allergies: allergies || [],
            conditions: conditions || [],
            medicalNotes: medicalNotes || null
          }, session);

          if (orgId) {
            await createWithSession(OrgMember, {
              userId: newPatientUser._id,
              organizationId: orgId,
              role: "patient"
            }, session);

            // ANANTA v1.0: Automatically create initial Consent Grant for clinic
            const consentGrant = await createWithSession(Consent, {
              patientId: patientProfile._id,
              grantee: { organizationId: orgId, doctorId },
              status: "active",
              scope: ["READ_TIMELINE", "WRITE_ENCOUNTER", "VIEW_LABS", "VIEW_IMAGING"],
              period: { start: new Date(), end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) }, // 1 Year Initial Grant
              provision: { type: "permit", purpose: ["TREATMENT", "BILLING"] },
              audit: { grantedAt: new Date(), grantedVia: "DEFAULT_INITIAL_REGISTRATION" },
            }, session);

            // Update patient activeConsentGrants
            await Patient.findByIdAndUpdate(patientProfile._id, { $addToSet: { activeConsentGrants: consentGrant._id } }, option);
          }

          finalPatientId = patientProfile.id;
        } else {
          return reply.code(400).send(errorResponse("Either patientId or patientDetails is required for staff booking"));
        }
      }

      // 2. Generate Sequential Daily Token Number for Doctor + Clinic
      const requestedDate = new Date(appointmentTime);
      const startOfDay = new Date(requestedDate.getFullYear(), requestedDate.getMonth(), requestedDate.getDate());
      const endOfDay = new Date(requestedDate.getFullYear(), requestedDate.getMonth(), requestedDate.getDate(), 23, 59, 59, 999);

      const countToday = await Appointment.countDocuments(
        {
          doctorId,
          clinicId,
          appointmentTime: { $gte: startOfDay, $lte: endOfDay }
        },
        option
      );

      const tokenNumber = countToday + 1;
      const queuePosition = tokenNumber;

      const initialStatus = (userRole === "admin" || userRole === "receptionist") ? "confirmed" : "pending";
      const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
      const slotDuration = (req.body as any).duration || assignment?.appointmentDuration || 15;
      const visitReason = (req.body as any).reasonForVisit || (followUpForAppointmentId ? "follow_up" : "new_consultation");

      // 3. Create Appointment Document
      const appointment = await createWithSession(Appointment, {
        organizationId: orgId || clinicAccess.organizationId || null,
        clinicId,
        doctorId,
        patientId: finalPatientId,
        appointmentTime: requestedDate,
        appointmentType,
        status: initialStatus,
        tokenNumber,
        queuePosition,
        duration: slotDuration,
        reasonForVisit: visitReason,
        notes: notes || null
      }, session);

      // 4. Optionally handle Follow-Up link
      if (followUpForAppointmentId) {
        await Appointment.findByIdAndUpdate(followUpForAppointmentId, { status: "completed" }, option);
      }

      // 5. Automatically generate Consultation Fee Invoice
      if (assignment?.fees && assignment.fees > 0) {
        const year = requestedDate.getFullYear();
        const count = await Invoice.countDocuments({}, option);
        const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

        await createWithSession(Invoice, {
          invoiceNumber,
          patientId: finalPatientId,
          appointmentId: appointment._id,
          clinicId,
          doctorId,
          items: [
            {
              description: `Consultation Fee - Dr. ${doctorId}`,
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

      // 6. Audit Log
      await createWithSession(AuditLog, {
        userId,
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

    // Validate slot lock anti-double booking
    const lockValidation = await validateSlotLockForBooking(
      appointment.clinicId.toString(),
      appointment.doctorId.toString(),
      newTime,
      userId,
      lockId
    );
    if (!lockValidation.valid) {
      return reply.code(409).send(errorResponse(lockValidation.message));
    }

    const oldTimeStr = new Date(appointment.appointmentTime).toLocaleString();

    // Recalculate daily token number & queue position for the new date
    const startOfDay = new Date(newDateObj.getFullYear(), newDateObj.getMonth(), newDateObj.getDate());
    const endOfDay = new Date(newDateObj.getFullYear(), newDateObj.getMonth(), newDateObj.getDate(), 23, 59, 59, 999);
    const countToday = await Appointment.countDocuments({
      doctorId: appointment.doctorId,
      clinicId: appointment.clinicId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay },
      _id: { $ne: appointment._id },
    });

    appointment.appointmentTime = newDateObj;
    appointment.tokenNumber = countToday + 1;
    appointment.queuePosition = countToday + 1;
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
      action: "APPOINTMENT_RESCHEDULE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { oldTime: oldTimeStr, newTime, reason }
    });

    return reply.code(200).send(successResponse(appointment, `Appointment successfully rescheduled to ${newDateObj.toLocaleString()}`));
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

    if (!(await ensureAppointmentClinicAccess(req, reply, clinicId))) return;

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

    if (appointment.status === "completed" || appointment.status === "cancelled") {
      return reply.code(400).send(errorResponse(`Cannot cancel appointment already in '${appointment.status}' status`));
    }

    appointment.status = "cancelled";
    if (reason) appointment.notes = `Cancelled by patient: ${reason}`;
    await appointment.save();

    sendBookingNotification(appointment._id, "cancelled").catch((err) => console.error("Cancellation notification failed:", err));

    await AuditLog.create({
      userId: req.user!.id,
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

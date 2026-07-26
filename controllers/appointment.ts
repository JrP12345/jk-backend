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

export async function bookAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const orgId = req.user?.organization_id;

    const {
      clinicId, doctorId, appointmentTime, appointmentType, notes, patientId, patientDetails, followUpForAppointmentId
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
        address?: string;
        allergies?: string[];
        conditions?: string[];
        medicalNotes?: string;
      };
      followUpForAppointmentId?: string;
    };

    if (!clinicId || !doctorId || !appointmentTime || !appointmentType) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, appointmentTime, and appointmentType are required"));
    }

    if (userRole !== "patient" && userRole !== "admin" && userRole !== "receptionist") {
      return reply.code(403).send(errorResponse("Forbidden: role cannot book appointments"));
    }

    // Validate Doctor Assignment at Clinic
    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId });
    if (!assignment) {
      return reply.code(400).send(errorResponse("Doctor is not assigned to the selected clinic"));
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
        finalPatientId = patient.id;
      } else {
        // Staff booking
        if (patientId) {
          const patient = await Patient.findById(patientId, null, option);
          if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
          finalPatientId = patient.id;

          // Ensure Patient is linked to OrgMember if not already
          if (orgId) {
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

          const finalEmail = email || `patient_${phone || Date.now()}_${Math.floor(Math.random() * 1000)}@healthos.placeholder.com`;
          
          const emailExists = await User.findOne({ email: finalEmail }, null, option);
          if (emailExists) {
            return reply.code(409).send(errorResponse("Email already registered"));
          }

          const hashedPassword = await bcrypt.hash(Math.random().toString(36).substring(2, 10), 10);

          const newPatientUser = await createWithSession(User, {
            name,
            email: finalEmail,
            password: hashedPassword,
            phone: phone || null,
            role: "patient"
          }, session);

          const patientProfile = await createWithSession(Patient, {
            userId: newPatientUser._id,
            organizationId: orgId || null,
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

      // 3. Create Appointment Document
      const appointment = await createWithSession(Appointment, {
        clinicId,
        doctorId,
        patientId: finalPatientId,
        appointmentTime: requestedDate,
        appointmentType,
        status: initialStatus,
        tokenNumber,
        queuePosition,
        notes: notes || null
      }, session);

      // 4. Optionally handle Follow-Up link
      if (followUpForAppointmentId) {
        await Appointment.findByIdAndUpdate(followUpForAppointmentId, { status: "completed" }, option);
      }

      // 5. Automatically generate Consultation Fee Invoice
      if (assignment.fees && assignment.fees > 0) {
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

      // 7. Async Notification Dispatch
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
      filter.clinicId = clinicId;
    } else if (orgId && userRole !== "patient") {
      // Limit to clinics in requesting user's organization
      const orgClinics = await Clinic.find({ organizationId: orgId }).select("_id");
      const clinicIds = orgClinics.map(c => c._id);
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

    const allowedStatuses = ["pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled"];
    if (!allowedStatuses.includes(status)) {
      return reply.code(400).send(errorResponse("Invalid status value"));
    }

    const appointment = await Appointment.findById(id);
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));

    appointment.status = status as any;
    if (notes) appointment.notes = notes;
    await appointment.save();

    if (status === "cancelled") {
      sendBookingNotification(appointment._id, "cancelled").catch((err) => console.error("Cancellation notification dispatch failed:", err));
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

// ─── Get Doctor Time Slot Availability ─────────────────────────
export async function getDoctorSlots(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { doctorId } = req.params as { doctorId: string };
    const { clinicId, date } = req.query as { clinicId: string; date: string };

    if (!doctorId || !clinicId || !date) {
      return reply.code(400).send(errorResponse("doctorId, clinicId, and date (YYYY-MM-DD) are required"));
    }

    const { getDoctorAvailableSlots } = await import("../services/SlotService.ts");
    const result = await getDoctorAvailableSlots(doctorId, clinicId, date);

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

    return reply.code(200).send(successResponse(appointment));
  } catch (err) {
    console.error("getAppointmentById error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}




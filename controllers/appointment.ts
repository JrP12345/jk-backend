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
import { successResponse, errorResponse, generateKeyPair, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { sendBookingNotification } from "../utilities/notifications.ts";

export async function bookAppointment(req: FastifyRequest, reply: FastifyReply) {
  let createdUserId: string | null = null;
  let createdPatientId: string | null = null;

  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;

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

    let finalPatientId: string;

    // 1. Identify or Create Patient Profile
    if (userRole === "patient") {
      // Patient booking for themselves
      const patient = await Patient.findOne({ userId });
      if (!patient) {
        return reply.code(404).send(errorResponse("Patient profile not found for your account"));
      }
      finalPatientId = patient.id;
    } else if (userRole === "admin" || userRole === "receptionist") {
      // Staff booking
      if (patientId) {
        // Book for existing patient
        const patient = await Patient.findById(patientId);
        if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
        finalPatientId = patient.id;
      } else if (patientDetails) {
        // Book for new patient (Auto-register patient User & Profile)
        const { name, dob, gender, phone, email, address, allergies, conditions, medicalNotes } = patientDetails;
        if (!name || !dob || !gender) {
          return reply.code(400).send(errorResponse("name, dob, and gender are required for new patient registration"));
        }

        // Generate unique placeholder email if email is not provided
        const finalEmail = email || `patient_${phone || Date.now()}_${Math.floor(Math.random() * 1000)}@healthos.placeholder.com`;
        
        const emailExists = await User.findOne({ email: finalEmail });
        if (emailExists) {
          return reply.code(409).send(errorResponse("Email already registered"));
        }

        const hashedPassword = await bcrypt.hash(Math.random().toString(36).substring(2, 10), 10);
        const { publicKey, privateKey } = generateKeyPair();

        const newPatientUser = await User.create({
          name,
          email: finalEmail,
          password: hashedPassword,
          phone: phone || null,
          role: "patient",
          publicKey,
          privateKey
        });
        createdUserId = newPatientUser._id.toString();

        const patientProfile = await Patient.create({
          userId: newPatientUser._id,
          dob: new Date(dob),
          gender,
          address: address || null,
          allergies: allergies || [],
          conditions: conditions || [],
          medicalNotes: medicalNotes || null
        });
        createdPatientId = patientProfile._id.toString();

        finalPatientId = patientProfile.id;
      } else {
        return reply.code(400).send(errorResponse("Either patientId or patientDetails is required for staff booking"));
      }
    } else {
      return reply.code(403).send(errorResponse("Forbidden: doctor cannot book appointments"));
    }

    // 2. Verify Doctor Assignment to Clinic
    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId, isActive: true });
    if (!assignment) {
      if (createdPatientId) await Patient.deleteOne({ _id: createdPatientId }).catch(console.error);
      if (createdUserId) await User.deleteOne({ _id: createdUserId }).catch(console.error);
      return reply.code(400).send(errorResponse("Doctor is not assigned to this clinic location"));
    }

    // 3. Generate Sequential Daily Token Number
    const targetDate = new Date(appointmentTime);
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(targetDate);
    endOfDay.setHours(23, 59, 59, 999);

    const count = await Appointment.countDocuments({
      doctorId,
      clinicId,
      appointmentTime: { $gte: startOfDay, $lte: endOfDay }
    });
    const tokenNumber = count + 1;

    // 4. Create Appointment
    // Auto-confirm bookings created by staff, set pending for online patient bookings
    const initialStatus = (userRole === "admin" || userRole === "receptionist") ? "confirmed" : "pending";

    const appointment = await Appointment.create({
      clinicId,
      doctorId,
      patientId: finalPatientId,
      appointmentTime,
      appointmentType,
      status: initialStatus,
      tokenNumber,
      queuePosition: tokenNumber, // default queue position is token number
      notes: notes || null,
      followUpForAppointmentId: followUpForAppointmentId || null
    });

    // Create Audit Log
    await AuditLog.create({
      userId,
      action: "APPOINTMENT_CREATE",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { tokenNumber, status: initialStatus, appointmentTime }
    });

    // Trigger email notification asynchronously
    sendBookingNotification(appointment._id, "booked").catch((err) =>
      console.error("Failed to send booking notification:", err)
    );

    return reply.code(201).send(successResponse(appointment, "Appointment booked successfully"));
  } catch (err) {
    console.error("bookAppointment error:", err);
    if (createdPatientId) {
      await Patient.deleteOne({ _id: createdPatientId }).catch(console.error);
    }
    if (createdUserId) {
      await User.deleteOne({ _id: createdUserId }).catch(console.error);
    }
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getAppointments(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user!.role;
    const userId = req.user!.id;
    const { clinicId, doctorId, status, date, page, limit } = req.query as {
      clinicId?: string; doctorId?: string; status?: string; date?: string;
      page?: string | number; limit?: string | number;
    };

    const query: any = {};

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient) return reply.code(200).send(successResponse([]));
      query.patientId = patient.id;
    } else if (userRole === "doctor") {
      query.doctorId = userId;
    } else if (userRole === "admin" || userRole === "receptionist") {
      if (clinicId) query.clinicId = clinicId;
      if (doctorId) query.doctorId = doctorId;
    } else {
      return reply.code(403).send(errorResponse("Unauthorized role"));
    }

    if (status) query.status = status;

    if (date) {
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);
      query.appointmentTime = { $gte: startOfDay, $lte: endOfDay };
    }

    const totalCount = await Appointment.countDocuments(query);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const appointments = await Appointment.find(query)
      .populate("clinicId", "name city address")
      .populate("doctorId", "name email phone specialization")
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

export async function updateAppointmentStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const {
      status, followUpRecommended, followUpTimeline, followUpNotes,
      symptoms, diagnosis, prescriptions
    } = req.body as {
      status: string;
      followUpRecommended?: boolean;
      followUpTimeline?: string;
      followUpNotes?: string;
      symptoms?: string;
      diagnosis?: string;
      prescriptions?: Array<{ name: string; dosage: string; duration: string }>;
    };

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }

    const validStatuses = ["pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show"];
    if (!status || !validStatuses.includes(status)) {
      return reply.code(400).send(errorResponse("Invalid status value"));
    }

    const oldAppointment = await Appointment.findById(id);
    if (!oldAppointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }
    const oldStatus = oldAppointment.status;

    const updateData: any = { status };
    if (status === "completed") {
      updateData.followUpRecommended = !!followUpRecommended;
      updateData.followUpTimeline = followUpTimeline || null;
      updateData.followUpNotes = followUpNotes || null;
      updateData.symptoms = symptoms || null;
      updateData.diagnosis = diagnosis || null;
      updateData.prescriptions = prescriptions || [];
    }

    const updated = await Appointment.findByIdAndUpdate(
      id,
      updateData,
      { new: true }
    );

    // Auto-create Invoice if status is updated to completed
    if (status === "completed") {
      try {
        const assignment = await DoctorAssignment.findOne({
          doctorId: oldAppointment.doctorId,
          clinicId: oldAppointment.clinicId,
          isActive: true
        });
        const fee = assignment ? assignment.fees : 200;

        const existingInvoice = await Invoice.findOne({ appointmentId: id });
        if (!existingInvoice) {
          const year = new Date().getFullYear();
          const count = await Invoice.countDocuments();
          const invoiceNumber = `INV-${year}-${(count + 1).toString().padStart(5, "0")}`;

          await Invoice.create({
            invoiceNumber,
            patientId: oldAppointment.patientId,
            clinicId: oldAppointment.clinicId,
            doctorId: oldAppointment.doctorId,
            appointmentId: id,
            items: [{
              description: "General Consultation Fee",
              amount: fee,
              quantity: 1
            }],
            subtotal: fee,
            totalAmount: fee,
            status: "unpaid"
          });
        }
      } catch (invoiceErr) {
        console.error("Auto-invoice creation failed:", invoiceErr);
      }
    }

    // Create Audit Log
    await AuditLog.create({
      userId: req.user!.id,
      action: "STATUS_CHANGE",
      targetId: updated!._id,
      targetModel: "Appointment",
      details: { oldStatus, newStatus: status }
    });

    // Trigger cancellation email asynchronously if status is cancelled
    if (status === "cancelled") {
      sendBookingNotification(updated!._id, "cancelled").catch((err) =>
        console.error("Failed to send cancellation notification:", err)
      );
    }

    return reply.code(200).send(successResponse(updated, `Appointment status updated to ${status}`));
  } catch (err) {
    console.error("updateAppointmentStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

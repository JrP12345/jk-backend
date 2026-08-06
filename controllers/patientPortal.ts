import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { RefillRequest } from "../models/RefillRequest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { checkClinicAccess, checkOperationalRecordAccess } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

function requirePatient(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role !== "patient") {
    reply.code(403).send(errorResponse("Patient account required"));
    return false;
  }
  return true;
}

// ─── GET /api/patient/me ──────────────────────────────────────────────
export async function getCurrentPatientProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePatient(req, reply)) return;
    const userId = req.user?.id;
    if (!userId) {
      return reply.code(401).send(errorResponse("Unauthorized"));
    }

    const user = await User.findById(userId).select("-password -passwordResetToken -emailVerificationToken");
    if (!user) {
      return reply.code(404).send(errorResponse("User not found"));
    }

    let patient = await Patient.findOne({ userId }).populate("userId", "name email phone role avatar");
    if (!patient) {
      // Auto-create patient record if not exists
      patient = await Patient.create({
        userId: user._id,
        organizationId: req.user?.organization_id ? new mongoose.Types.ObjectId(req.user.organization_id) : undefined,
      });
      patient = await Patient.findById(patient._id).populate("userId", "name email phone role avatar");
    }

    return reply.code(200).send(successResponse({ user, patient }));
  } catch (err) {
    console.error("getCurrentPatientProfile error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── PUT /api/patient/me ──────────────────────────────────────────────
export async function updateCurrentPatientProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePatient(req, reply)) return;
    const userId = req.user?.id;
    if (!userId) {
      return reply.code(401).send(errorResponse("Unauthorized"));
    }

    const {
      name,
      phone,
      dob,
      gender,
      bloodGroup,
      address,
      allergies,
      conditions,
      medicalNotes,
      emergencyContacts,
      insurancePolicies,
    } = req.body as {
      name?: string;
      phone?: string;
      dob?: string;
      gender?: "male" | "female" | "other";
      bloodGroup?: string;
      address?: string;
      allergies?: string[];
      conditions?: string[];
      medicalNotes?: string;
      emergencyContacts?: Array<{ name: string; relationship: string; phone: string }>;
      insurancePolicies?: Array<{ providerName: string; policyNumber: string; coverageAmount?: number; validUntil?: string }>;
    };

    if (name || phone) {
      const userUpdate: any = {};
      if (name) userUpdate.name = name.trim();
      if (phone) userUpdate.phone = phone.trim();
      await User.findByIdAndUpdate(userId, userUpdate);
    }

    let patient = await Patient.findOne({ userId });
    if (!patient) {
      patient = new Patient({
        userId,
        organizationId: req.user?.organization_id ? new mongoose.Types.ObjectId(req.user.organization_id) : undefined,
      });
    }

    if (dob) patient.dob = new Date(dob);
    if (gender) patient.gender = gender;
    if (bloodGroup) patient.bloodGroup = bloodGroup as any;
    if (address !== undefined) patient.address = address;
    if (allergies) patient.allergies = allergies;
    if (conditions) patient.conditions = conditions;
    if (medicalNotes !== undefined) patient.medicalNotes = medicalNotes;
    if (emergencyContacts) patient.emergencyContacts = emergencyContacts as any;
    if (insurancePolicies) patient.insurancePolicies = insurancePolicies as any;

    await patient.save();
    const updatedPatient = await Patient.findById(patient._id).populate("userId", "name email phone role avatar");

    return reply.code(200).send(successResponse(updatedPatient, "Patient profile updated successfully"));
  } catch (err) {
    console.error("updateCurrentPatientProfile error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/prescriptions/:id/refill ────────────────────────────────
export async function createPrescriptionRefillRequest(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePatient(req, reply)) return;
    const { id } = req.params as { id: string }; // prescriptionId
    const userId = req.user?.id;
    const { reason } = req.body as { reason: string };

    if (!reason || !reason.trim()) {
      return reply.code(400).send(errorResponse("Refill reason is required"));
    }

    const prescription = await Prescription.findById(id);
    if (!prescription) {
      return reply.code(404).send(errorResponse("Prescription not found"));
    }

    const prescriptionAccess = await checkOperationalRecordAccess(req, prescription);
    if (!prescriptionAccess.allowed) return sendTenantError(reply, prescriptionAccess);
    if (prescription.status !== "active") {
      return reply.code(400).send(errorResponse("Only active prescriptions can be refilled"));
    }

    const patient = await Patient.findOne({ userId });
    if (!patient || prescription.patientId.toString() !== patient._id.toString()) {
      return reply.code(403).send(errorResponse("You can only request refills for your own active prescriptions"));
    }

    // Check if pending refill request already exists
    const existingPending = await RefillRequest.findOne({
      prescriptionId: id,
      status: "pending",
    });
    if (existingPending) {
      return reply.code(409).send(errorResponse("A refill request for this prescription is already pending review"));
    }

    const refill = await RefillRequest.create({
      organizationId: prescription.organizationId,
      clinicId: prescription.clinicId,
      prescriptionId: prescription._id,
      patientId: patient._id,
      doctorId: prescription.doctorId,
      requestedBy: userId,
      reason: reason.trim(),
      status: "pending",
    });

    // Publish domain event
    await domainEventBus.publish({
      eventId: `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      eventType: "PRESCRIPTION_REFILL_REQUESTED",
      eventVersion: 1,
      occurredAt: new Date(),
      payload: {
        refillId: refill._id.toString(),
        prescriptionId: id,
        patientId: patient._id.toString(),
        doctorId: prescription.doctorId.toString(),
        clinicId: prescription.clinicId.toString(),
        reason: reason.trim(),
      },
    } as any);

    return reply.code(201).send(successResponse(refill, "Prescription refill request submitted successfully"));
  } catch (err) {
    console.error("createPrescriptionRefillRequest error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/prescriptions/refills ───────────────────────────────────
export async function getPrescriptionRefillRequests(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userRole = req.user?.role;
    const userId = req.user?.id;
    const { status, page, limit } = req.query as { status?: string; page?: string | number; limit?: string | number };

    const filter: any = { deletedAt: null };
    if (status) filter.status = status;

    if (userRole === "patient") {
      const patient = await Patient.findOne({ userId });
      if (!patient) return reply.code(404).send(errorResponse("Patient profile not found"));
      filter.patientId = patient._id;
    } else if (userRole === "doctor") {
      filter.doctorId = userId;
    } else if (req.user?.organization_id) {
      filter.organizationId = req.user.organization_id;
    }

    if (userRole !== "patient" && userRole !== "doctor" && !["admin", "receptionist", "root"].includes(userRole || "")) {
      return reply.code(403).send(errorResponse("You are not allowed to view refill requests"));
    }

    const totalCount = await RefillRequest.countDocuments(filter);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const refills = await RefillRequest.find(filter)
      .populate("prescriptionId")
      .populate("patientId")
      .populate("requestedBy", "name email phone")
      .populate("doctorId", "name email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(refills));
  } catch (err) {
    console.error("getPrescriptionRefillRequests error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── PATCH /api/prescriptions/refills/:id ──────────────────────────────
export async function updatePrescriptionRefillRequestStatus(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const { status, decisionNotes } = req.body as { status: "approved" | "rejected"; decisionNotes?: string };
    const userId = req.user?.id;

    if (!userId || !["admin", "receptionist", "doctor", "root"].includes(req.user?.role || "")) {
      return reply.code(403).send(errorResponse("Only authorized clinical staff can decide refill requests"));
    }

    if (!["approved", "rejected"].includes(status)) {
      return reply.code(400).send(errorResponse("Status must be either 'approved' or 'rejected'"));
    }

    const refill = await RefillRequest.findById(id);
    if (!refill) {
      return reply.code(404).send(errorResponse("Refill request not found"));
    }

    const refillAccess = await checkOperationalRecordAccess(req, refill);
    if (!refillAccess.allowed) return sendTenantError(reply, refillAccess);
    if (refill.status !== "pending") {
      return reply.code(400).send(errorResponse("Only pending refill requests can be decided"));
    }

    refill.status = status;
    refill.decisionNotes = decisionNotes || "";
    refill.decidedBy = new mongoose.Types.ObjectId(userId);
    refill.decidedAt = new Date();
    await refill.save();

    return reply.code(200).send(successResponse(refill, `Refill request ${status} successfully`));
  } catch (err) {
    console.error("updatePrescriptionRefillRequestStatus error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/patient-portal/self-book ────────────────────────────────
export async function patientSelfBookAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePatient(req, reply)) return;
    const userId = req.user!.id;
    const orgId = req.user?.organization_id;

    const { clinicId, doctorId, appointmentTime, appointmentType, notes, lockId } = req.body as {
      clinicId: string;
      doctorId: string;
      appointmentTime: string;
      appointmentType?: "online" | "walk-in" | "reception";
      notes?: string;
      lockId?: string;
    };

    if (!clinicId || !doctorId || !appointmentTime) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, and appointmentTime are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId) || !mongoose.Types.ObjectId.isValid(doctorId)) {
      return reply.code(400).send(errorResponse("Invalid clinic or doctor ID"));
    }
    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    // Ensure patient profile exists
    let patient = await Patient.findOne({ userId });
    if (!patient) {
      patient = await Patient.create({
        userId,
        organizationId: clinicAccess.organizationId ? new mongoose.Types.ObjectId(clinicAccess.organizationId) : (orgId ? new mongoose.Types.ObjectId(orgId) : undefined),
      });
    } else if (patient.organizationId && clinicAccess.organizationId && patient.organizationId.toString() !== clinicAccess.organizationId) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    } else if (!patient.organizationId && clinicAccess.organizationId) {
      patient.organizationId = new mongoose.Types.ObjectId(clinicAccess.organizationId);
      await patient.save();
    }

    const { validateSlotLockForBooking, forceReleaseSlotLock } = await import("../services/SlotLockService.ts");
    const { Appointment } = await import("../models/Appointment.ts");
    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
    const { getNextAtomicSequence } = await import("../models/Counter.ts");
    const { sendBookingNotification } = await import("../utilities/notifications.ts");
    const { AuditLog } = await import("../models/AuditLog.ts");

    // Verify doctor assignment
    const assignment = await DoctorAssignment.findOne({ doctorId, clinicId });
    if (!assignment) {
      return reply.code(400).send(errorResponse("Doctor is not assigned to the selected clinic"));
    }

    // Validate anti-double-booking slot lock
    const lockValidation = await validateSlotLockForBooking(clinicId, doctorId, appointmentTime, userId, lockId);
    if (!lockValidation.valid) {
      return reply.code(409).send(errorResponse(lockValidation.message));
    }

    const apptDateStr = new Date(appointmentTime).toISOString().split("T")[0];
    const counterId = `queue_${clinicId}_${doctorId}_${apptDateStr}`;
    const tokenNumber = await getNextAtomicSequence(counterId);

    const appointment = await Appointment.create({
      patientId: patient._id,
      doctorId,
      clinicId,
      appointmentTime: new Date(appointmentTime),
      appointmentType: appointmentType || "online",
      notes: notes?.trim(),
      status: "confirmed",
      tokenNumber,
      queuePosition: tokenNumber,
    });

    if (lockValidation.lockKey) {
      forceReleaseSlotLock(lockValidation.lockKey).catch(() => {});
    }

    sendBookingNotification(appointment._id, "booked").catch(() => {});

    await AuditLog.create({
      userId,
      action: "PATIENT_SELF_BOOKING",
      targetId: appointment._id,
      targetModel: "Appointment",
      details: { tokenNumber, appointmentTime, clinicId, doctorId }
    });

    return reply.code(201).send(
      successResponse(
        {
          appointment,
          tokenNumber,
          queuePosition: tokenNumber,
        },
        `Appointment booked successfully! Your Queue Token Number is #${tokenNumber}`
      )
    );
  } catch (err) {
    console.error("patientSelfBookAppointment error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/patient-portal/appointments ─────────────────────────────
export async function getPatientAppointmentsHistory(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePatient(req, reply)) return;
    const userId = req.user!.id;
    const patient = await Patient.findOne({ userId });
    if (!patient) {
      return reply.code(200).send(successResponse([]));
    }

    const { Appointment } = await import("../models/Appointment.ts");
    const appointments = await Appointment.find({ patientId: patient._id })
      .populate("doctorId", "name email phone")
      .populate("clinicId", "name address phone")
      .sort({ appointmentTime: -1 });

    return reply.code(200).send(successResponse(appointments));
  } catch (err) {
    console.error("getPatientAppointmentsHistory error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/patient-portal/records ─────────────────────────────────
export async function getPatientMedicalRecords(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePatient(req, reply)) return;
    const userId = req.user!.id;
    const patient = await Patient.findOne({ userId }).populate("userId", "name email phone");
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const { ClinicalNote } = await import("../models/ClinicalNote.ts");
    const { LabOrder } = await import("../models/LabOrder.ts");

    const prescriptions = await Prescription.find({ patientId: patient._id }).sort({ createdAt: -1 });
    const clinicalNotes = await ClinicalNote.find({ patientId: patient._id }).sort({ createdAt: -1 });
    const labOrders = await LabOrder.find({ patientId: patient._id }).populate("testId", "name code").sort({ createdAt: -1 });

    const medicalRecordSummary = {
      patient,
      prescriptions,
      clinicalNotes,
      labOrders,
      exportedAt: new Date().toISOString(),
    };

    return reply.code(200).send(successResponse(medicalRecordSummary, "Patient longitudinal medical records retrieved"));
  } catch (err) {
    console.error("getPatientMedicalRecords error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

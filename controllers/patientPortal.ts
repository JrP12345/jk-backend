import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { RefillRequest } from "../models/RefillRequest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";

// ─── GET /api/patient/me ──────────────────────────────────────────────
export async function getCurrentPatientProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
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
      patient = new Patient({ userId });
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

    if (!["approved", "rejected"].includes(status)) {
      return reply.code(400).send(errorResponse("Status must be either 'approved' or 'rejected'"));
    }

    const refill = await RefillRequest.findById(id);
    if (!refill) {
      return reply.code(404).send(errorResponse("Refill request not found"));
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

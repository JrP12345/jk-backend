import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { RefillRequest } from "../models/RefillRequest.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { eventBus } from "../events/eventBus.ts";
import { checkClinicAccess, checkOperationalRecordAccess, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { requestHasAnyPermission } from "../utilities/permissions.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

function requirePortalPatient(req: FastifyRequest, reply: FastifyReply) {
  if (req.user?.role !== "patient") {
    reply.code(403).send(errorResponse("Patient account required"));
    return false;
  }
  return true;
}

// ─── GET /api/patient/me ──────────────────────────────────────────────
export async function getCurrentPatientProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePortalPatient(req, reply)) return;
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
        name: user.name,
        phone: user.phone,
        email: user.email || undefined,
        accountType: "self",
        createdBy: user._id,
        organizationId: (() => {
          const s = resolveAuthorizedOrganizationScope(req);
          const oid = s.allowed ? s.organizationId : req.user?.organization_id;
          return oid ? new mongoose.Types.ObjectId(oid) : undefined;
        })(),
      });
      const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
      await FamilyRelationship.findOneAndUpdate(
        { userId: user._id, patientId: patient._id },
        { relationship: "self", status: "active" },
        { upsert: true }
      );
      patient = await Patient.findById(patient._id).populate("userId", "name email phone role avatar");
    }

    const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
    const familyRels = await FamilyRelationship.find({ userId: user._id, status: "active" }).populate("patientId");
    const familyMembers = familyRels.map((rel: any) => ({
      relationshipId: rel._id.toString(),
      relationship: rel.relationship,
      patient: rel.patientId,
    }));

    return reply.code(200).send(successResponse({ user, patient, familyMembers }));
  } catch (err) {
    console.error("getCurrentPatientProfile error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── PUT /api/patient/me ──────────────────────────────────────────────
export async function updateCurrentPatientProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePortalPatient(req, reply)) return;
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
        organizationId: (() => {
          const s = resolveAuthorizedOrganizationScope(req);
          const oid = s.allowed ? s.organizationId : req.user?.organization_id;
          return oid ? new mongoose.Types.ObjectId(oid) : undefined;
        })(),
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
    if (!requirePortalPatient(req, reply)) return;
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

    // Publish durable domain event
    const eventId = `evt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    await eventBus.publishDurable({
      eventId,
      eventType: "PRESCRIPTION_REFILL_REQUESTED",
      category: "clinical",
      organizationId: prescription.organizationId?.toString(),
      metadata: {
        refillId: refill._id.toString(),
        prescriptionId: id,
        patientId: patient._id.toString(),
        doctorId: prescription.doctorId.toString(),
        clinicId: prescription.clinicId.toString(),
        reason: reason.trim(),
      },
    });

    await domainEventBus.publish({
      eventId,
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
    } else {
      const scope = resolveAuthorizedOrganizationScope(req);
      const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
      if (orgId) {
        filter.organizationId = orgId;
      }
    }

    if (userRole !== "patient" && userRole !== "doctor") {
      const allowed = await requestHasAnyPermission(req, "MANAGE_MEDICINES", "VIEW_EHR", "MANAGE_APPOINTMENTS");
      if (!allowed) {
        return reply.code(403).send(errorResponse("You are not allowed to view refill requests"));
      }
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

    if (!userId || !(await requestHasAnyPermission(req, "MANAGE_MEDICINES", "MANAGE_APPOINTMENTS"))) {
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
    if (!requirePortalPatient(req, reply)) return;
    const userId = req.user!.id;
    const scope = resolveAuthorizedOrganizationScope(req);
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;

    const { clinicId, doctorId, appointmentTime, appointmentType, notes, lockId, forPatientId, payAtClinic } = req.body as {
      clinicId: string;
      doctorId: string;
      appointmentTime: string;
      appointmentType?: "online" | "walk-in" | "reception";
      notes?: string;
      lockId?: string;
      forPatientId?: string;
      payAtClinic?: boolean;
    };

    if (!clinicId || !doctorId || !appointmentTime) {
      return reply.code(400).send(errorResponse("clinicId, doctorId, and appointmentTime are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(clinicId) || !mongoose.Types.ObjectId.isValid(doctorId)) {
      return reply.code(400).send(errorResponse("Invalid clinic or doctor ID"));
    }
    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
    let targetPatientId: string;

    if (forPatientId) {
      const isAuthorized = await FamilyRelationship.findOne({ userId, patientId: forPatientId, status: "active" });
      if (!isAuthorized) {
        return reply.code(403).send(errorResponse("Unauthorized: You do not have permission to book for this patient"));
      }
      targetPatientId = forPatientId;
    } else {
      let selfRel = await FamilyRelationship.findOne({ userId, relationship: "self", status: "active" });
      let patient = selfRel ? await Patient.findById(selfRel.patientId) : await Patient.findOne({ userId });

      if (!patient) {
        const userObj = await User.findById(userId);
        patient = await Patient.create({
          userId,
          name: userObj?.name || "Patient",
          phone: userObj?.phone || undefined,
          email: userObj?.email || undefined,
          accountType: "self",
          createdBy: userId,
          organizationId: clinicAccess.organizationId ? new mongoose.Types.ObjectId(clinicAccess.organizationId) : (orgId ? new mongoose.Types.ObjectId(orgId) : undefined),
        });
        await FamilyRelationship.findOneAndUpdate(
          { userId, patientId: patient._id },
          { relationship: "self", status: "active" },
          { upsert: true }
        );
      }
      targetPatientId = patient.id;
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

    const mode = (assignment as any)?.bookingMode;
    const isSequentialQueue = mode ? mode === "sequential_queue" : true;

    // Validate anti-double-booking slot lock (only for time_slot mode)
    let lockValidation: { valid: boolean; message?: string; lockKey?: string } = { valid: true };
    if (!isSequentialQueue) {
      lockValidation = await validateSlotLockForBooking(clinicId, doctorId, appointmentTime, userId, lockId);
      if (!lockValidation.valid) {
        return reply.code(409).send(errorResponse(lockValidation.message || "Slot is unavailable"));
      }
    }

    const apptDateStr = new Date(appointmentTime).toISOString().split("T")[0];
    const counterId = `queue_${clinicId}_${doctorId}_${apptDateStr}`;
    const tokenNumber = await getNextAtomicSequence(counterId);

    const maxTokens = (assignment as any)?.maxDailyTokens;
    if (maxTokens && tokenNumber > maxTokens) {
      return reply.code(400).send(errorResponse(`Daily token limit of ${maxTokens} reached for this practitioner.`));
    }

    const isPaymentRequired = (assignment as any)?.paymentRequired === true;
    const initialStatus = isPaymentRequired ? "pending_payment" : "confirmed";
    const initialPaymentStatus = isPaymentRequired ? "pending" : (payAtClinic ? "pay_at_clinic" : "not_required");

    const appointment = await Appointment.create({
      patientId: targetPatientId,
      bookedByUserId: userId,
      doctorId,
      clinicId,
      appointmentTime: new Date(appointmentTime),
      appointmentType: appointmentType || "online",
      notes: notes?.trim(),
      status: initialStatus,
      paymentStatus: initialPaymentStatus,
      bookingSource: "patient_portal",
      tokenNumber,
      queuePosition: tokenNumber,
      bookingMode: (assignment as any).bookingMode || "sequential_queue",
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
      details: { tokenNumber, appointmentTime, clinicId, doctorId, targetPatientId }
    });

    return reply.code(201).send(
      successResponse(
        {
          appointment,
          tokenNumber,
          queuePosition: tokenNumber,
          paymentRequired: isPaymentRequired,
          fees: assignment.fees || 0,
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
    if (!requirePortalPatient(req, reply)) return;
    const userId = req.user!.id;

    const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
    const relationships = await FamilyRelationship.find({ userId, status: "active" });
    const familyPatientIds = relationships.map((r) => r.patientId);

    const { Appointment } = await import("../models/Appointment.ts");
    const appointments = await Appointment.find({
      $or: [
        { patientId: { $in: familyPatientIds } },
        { bookedByUserId: userId },
      ],
    })
      .populate("doctorId", "name email phone")
      .populate("clinicId", "name address phone")
      .populate("patientId", "name phone email dob gender accountType mrn")
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
    if (!requirePortalPatient(req, reply)) return;
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

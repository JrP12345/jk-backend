import { safeError } from "../utilities/safeError.ts";
import crypto from 'node:crypto';
import { Appointment } from '../models/Appointment.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { OperationReceipt } from '../models/OperationReceipt.ts';
import { appointmentService, AppointmentDomainError } from '../services/AppointmentService.ts';
import { executeRecordedCommand, CommandError } from '../services/CommandReceiptService.ts';
import { requestContextStore } from '../utilities/context.ts';
import { checkPatientAccess } from '../utilities/tenant.ts';
import { decryptField } from '../utilities/cryptoEnvelope.ts';
import { hashTrackerCapability } from '../utilities/publicTracker.ts';
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { RefillRequest } from "../models/RefillRequest.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { eventBus } from "../events/eventBus.ts";
import { checkLocationAccess, checkOperationalRecordAccess, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
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
    console.error("getCurrentPatientProfile error:", safeError(err));
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
    console.error("updateCurrentPatientProfile error:", safeError(err));
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
      locationId: prescription.locationId,
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
        locationId: prescription.locationId.toString(),
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
        locationId: prescription.locationId.toString(),
        reason: reason.trim(),
      },
    } as any);

    return reply.code(201).send(successResponse(refill, "Prescription refill request submitted successfully"));
  } catch (err) {
    console.error("createPrescriptionRefillRequest error:", safeError(err));
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
    console.error("getPrescriptionRefillRequests error:", safeError(err));
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
    console.error("updatePrescriptionRefillRequestStatus error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── POST /api/patient-portal/self-book ────────────────────────────────
export async function patientSelfBookAppointment(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePortalPatient(req, reply)) return;
    const input = req.body as { locationId: string; doctorId: string; appointmentTime: string; appointmentType?: 'online' | 'walk-in' | 'reception'; notes?: string; lockId?: string; forPatientId?: string; payAtLocation?: boolean; clientRequestId?: string };
    if (!mongoose.isValidObjectId(input.locationId) || !mongoose.isValidObjectId(input.doctorId) || (input.forPatientId && !mongoose.isValidObjectId(input.forPatientId))) throw new AppointmentDomainError('Valid branch, clinician and patient identifiers are required', 400);
    const branch = await checkLocationAccess(req, input.locationId);
    if (!branch.allowed) return sendTenantError(reply, branch);
    if (!branch.organizationId) throw new AppointmentDomainError('Branch organization is unavailable', 404);
    const scope = 'portal-booking:' + req.user!.id + ':' + branch.organizationId;
    const key = input.clientRequestId || crypto.randomUUID();
    const effects: (() => Promise<void>)[] = [];
    const command = await requestContextStore.run({ ...requestContextStore.getStore(), organizationId: branch.organizationId }, () => executeRecordedCommand(scope, key, input, async () => {
      const currentBranch = await checkLocationAccess(req, input.locationId);
      if (!currentBranch.allowed || currentBranch.organizationId !== branch.organizationId) throw new AppointmentDomainError('Branch authority changed', 403);
      const booking = await appointmentService.book({ id: req.user!.id, role: 'patient', organizationId: branch.organizationId }, {
        locationId: input.locationId, doctorId: input.doctorId, appointmentTime: input.appointmentTime, appointmentType: input.appointmentType || 'online',
        patientId: input.forPatientId, notes: input.notes?.trim(), lockId: input.lockId, payAtLocation: input.payAtLocation,
      }, branch.organizationId, { deferAfterCommit: effect => effects.push(effect) });
      await AuditLog.create({ organizationId: branch.organizationId, userId: req.user!.id, action: 'PATIENT_SELF_BOOKING', targetId: booking.id, targetModel: 'Appointment', category: 'ADMIN', details: { locationId: booking.locationId, doctorId: booking.doctorId, patientId: booking.patientId } });
      await OperationReceipt.updateOne({ scope, key }, { $set: { responseCiphertext: JSON.stringify(booking) } });
      return booking.id;
    }));
    const appointment = await Appointment.findOne({ _id: command.resultId, organizationId: branch.organizationId }).select('+trackerTokenHash');
    if (!appointment || !(await checkPatientAccess(req, String(appointment.patientId))).allowed) throw new AppointmentDomainError('Booking is no longer available in your scope', 404);
    const receipt = await OperationReceipt.findOne({ scope, key }).select('+responseCiphertext');
    if (!receipt?.responseCiphertext) throw new AppointmentDomainError('Booking was recorded; reception must review its response', 409);
    const recorded = JSON.parse(decryptField(receipt.responseCiphertext));
    const owner = await Patient.exists({ _id: appointment.patientId, userId: req.user!.id }).setOptions({ bypassTenantFilter: true });
    const trackerToken = owner && recorded.trackerToken && appointment.trackerTokenExpiresAt && appointment.trackerTokenExpiresAt > new Date() && hashTrackerCapability(recorded.trackerToken) === appointment.trackerTokenHash ? recorded.trackerToken : undefined;
    for (const effect of effects) await effect().catch(error => req.log.warn(safeError(error), 'Booking broadcast could not be refreshed'));
    return reply.code(command.replayed ? 200 : 201).send(successResponse({ appointment: { id: appointment.id, patientId: String(appointment.patientId), doctorId: String(appointment.doctorId), locationId: String(appointment.locationId), appointmentTime: appointment.appointmentTime, status: appointment.status, paymentStatus: appointment.paymentStatus, tokenNumber: appointment.tokenNumber, queuePosition: appointment.queuePosition, trackerToken }, tokenNumber: appointment.tokenNumber, queuePosition: appointment.queuePosition,
      paymentRequired: appointment.paymentStatus === 'pending', fees: appointment.paymentAmount, replayed: command.replayed }, 'Your visit was recorded. Review its current booking and payment status.'));
  } catch (error) {
    if (error instanceof AppointmentDomainError || error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
    req.log.error(safeError(error), 'Portal booking could not be confirmed');
    return reply.code(503).send(errorResponse('The booking result could not be confirmed. Retry the submitted request.'));
  }
}

// ─── GET /api/patient-portal/appointments ─────────────────────────────
export async function getPatientAppointmentsHistory(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePortalPatient(req, reply)) return;
    const userId = req.user!.id;

    const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
    const relationships = await FamilyRelationship.find({ userId, status: "active", identityClaim: { $ne: true } }).select('patientId');
    const ownedPatients = await Patient.find({ userId }).select('_id').setOptions({ bypassTenantFilter: true });
    const patientIds = [...relationships.map((r) => r.patientId), ...ownedPatients.map(patient => patient._id)];
    const { page, limit, skip } = getPaginationParams(req.query as any);

    const { Appointment } = await import("../models/Appointment.ts");
    const appointments = await Appointment.find({
      patientId: { $in: patientIds },
    })
      .select('patientId doctorId locationId appointmentTime appointmentType status paymentStatus tokenNumber queuePosition')
      .populate("doctorId", "name")
      .populate("locationId", "name address phone")
      .populate("patientId", "name")
      .sort({ appointmentTime: -1, _id: -1 }).skip(skip).limit(limit);
    const total = await Appointment.countDocuments({ patientId: { $in: patientIds } });
    setPaginationHeaders(reply, { currentPage: page, pageSize: limit, totalCount: total, totalPages: Math.ceil(total / limit) });

    return reply.code(200).send(successResponse(appointments));
  } catch (err) {
    console.error("getPatientAppointmentsHistory error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── GET /api/patient-portal/records ─────────────────────────────────
export async function getPatientMedicalRecords(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!requirePortalPatient(req, reply)) return;
    const userId = req.user!.id;
    const { limit: queryLimit } = req.query as { limit?: string | number };
    const maxSectionLimit = Math.min(100, Math.max(1, Number(queryLimit) || 25));

    const patient = await Patient.findOne({ userId }).populate("userId", "name email phone");
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const { ClinicalNote } = await import("../models/ClinicalNote.ts");
    const { LabOrder } = await import("../models/LabOrder.ts");

    // Step 5.3: Hard maximum limit and deterministic compound sorting
    const [prescriptions, clinicalNotes, labOrders] = await Promise.all([
      Prescription.find({ patientId: patient._id })
        .sort({ createdAt: -1, _id: -1 })
        .limit(maxSectionLimit)
        .lean(),
      ClinicalNote.find({ patientId: patient._id })
        .sort({ createdAt: -1, _id: -1 })
        .limit(maxSectionLimit)
        .lean(),
      LabOrder.find({ patientId: patient._id })
        .populate("testId", "name code")
        .sort({ createdAt: -1, _id: -1 })
        .limit(maxSectionLimit)
        .lean(),
    ]);

    const medicalRecordSummary = {
      patient,
      prescriptions,
      clinicalNotes,
      labOrders,
      exportedAt: new Date().toISOString(),
      sectionLimit: maxSectionLimit,
    };

    return reply.code(200).send(successResponse(medicalRecordSummary, "Patient longitudinal medical records retrieved"));
  } catch (err) {
    console.error("getPatientMedicalRecords error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

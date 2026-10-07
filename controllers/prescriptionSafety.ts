import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { Encounter } from "../models/Encounter.ts";
import { cdsEngine } from "../services/CDSEngine.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkLocationAccess, checkOperationalRecordAccess, checkPatientAccess, resolveTargetOrganizationId } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, result: { statusCode: number; message: string }) {
  return reply.code(result.statusCode).send(errorResponse(result.message));
}

export async function evaluatePrescriptionSafetyController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, proposedPrescriptions } = req.body as {
      patientId: string;
      proposedPrescriptions: Array<{ medicineName: string; medicineId?: string; dosage?: string }>;
    };

    if (!patientId || !Array.isArray(proposedPrescriptions)) {
      return reply.code(400).send(errorResponse("patientId and proposedPrescriptions array are required"));
    }

    if (!mongoose.isValidObjectId(patientId)) return reply.code(400).send(errorResponse("Invalid patient ID"));
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);

    const patient = await Patient.findById(patientId).lean();
    if (!patient) return reply.code(404).send(errorResponse("Patient not found"));

    // Fetch active prescriptions across recent encounters
    const activePrescriptions = await Prescription.find({
      patientId,
      status: "active",
      ...(req.user?.organization_id ? { organizationId: req.user.organization_id } : {}),
    }).select("medicineName medicineId").lean();

    const cdsContext = {
      patient: {
        id: patient._id.toString(),
        allergies: patient.allergies || [],
        conditions: patient.conditions || [],
      },
      activeMedications: activePrescriptions.map((p) => ({ medicineName: p.medicineName, medicineId: p.medicineId?.toString() })),
      proposedPrescriptions,
    };

    const evaluationResult = await cdsEngine.evaluate(cdsContext);
    return reply.code(200).send(successResponse(evaluationResult));
  } catch (err) {
    console.error("evaluatePrescriptionSafetyController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function recordSafetyDecisionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    let orgId = await resolveTargetOrganizationId(req);
    const userId = req.user?.id;
    const {
      locationId,
      encounterId,
      patientId,
      prescriptionIds,
      findings,
      clinicianDecision,
      overrideReason,
    } = req.body as {
      locationId: string;
      encounterId?: string;
      patientId: string;
      prescriptionIds?: string[];
      findings: any[];
      clinicianDecision: "accepted" | "overridden" | "blocked";
      overrideReason?: string;
    };

    if (!patientId || !locationId || !clinicianDecision) {
      return reply.code(400).send(errorResponse("locationId, patientId and clinicianDecision are required"));
    }

    if (!mongoose.isValidObjectId(patientId) || !mongoose.isValidObjectId(locationId)) {
      return reply.code(400).send(errorResponse("Invalid patient or location ID"));
    }
    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return sendTenantError(reply, locationAccess);

    if (!orgId && locationAccess.organizationId) {
      orgId = locationAccess.organizationId;
    }
    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));
    if (locationAccess.organizationId && locationAccess.organizationId !== orgId && req.user?.role !== "root") {
      return reply.code(403).send(errorResponse("Location does not belong to the active organization"));
    }
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);

    if (encounterId) {
      if (!mongoose.isValidObjectId(encounterId)) return reply.code(400).send(errorResponse("Invalid encounter ID"));
      const encounter = await Encounter.findById(encounterId).lean();
      if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
      const encounterAccess = await checkOperationalRecordAccess(req, encounter);
      if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);
      if (encounter.patientId?.toString() !== patientId || encounter.locationId?.toString() !== locationId) {
        return reply.code(400).send(errorResponse("Encounter does not match the selected patient and location"));
      }
    }

    if (clinicianDecision === "overridden" && (!overrideReason || !overrideReason.trim())) {
      return reply.code(400).send(errorResponse("overrideReason is required when overriding safety findings"));
    }

    const evaluationDoc = await CDSEvaluation.create({
      organizationId: orgId,
      locationId,
      encounterId: encounterId || null,
      patientId,
      prescriptionIds: prescriptionIds || [],
      engineVersion: cdsEngine.engineVersion,
      terminologyVersion: cdsEngine.terminologyVersion,
      interactionDatasetVersion: "2026.07.22",
      findings: findings || [],
      clinicianDecision,
      overrideReason: overrideReason || "",
      evaluatedAt: new Date(),
    });

    return reply.code(201).send(successResponse(evaluationDoc, "CDS Evaluation snapshot persisted successfully"));
  } catch (err) {
    console.error("overrideCDSEvaluationController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export const overrideCDSEvaluationController = recordSafetyDecisionController;

export async function verifyPrescriptionIntegrityController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    if (!mongoose.isValidObjectId(id)) return reply.code(400).send(errorResponse("Invalid prescription ID"));

    const prescription = await Prescription.findById(id).lean();
    if (!prescription) return reply.code(404).send(errorResponse("Prescription not found"));

    const access = await checkOperationalRecordAccess(req, prescription);
    if (!access.allowed) return sendTenantError(reply, access);

    const { PrescriptionSealingService } = await import("../services/PrescriptionSealingService.ts");
    const result = await PrescriptionSealingService.verifyPrescriptionIntegrity(id);
    return reply.code(200).send(successResponse(result, "Prescription integrity verified"));
  } catch (err: any) {
    console.error("verifyPrescriptionIntegrityController error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to verify prescription integrity"));
  }
}

export async function amendPrescriptionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const userId = req.user?.id;
    if (!userId) return reply.code(401).send(errorResponse("Authentication required"));
    if (!mongoose.isValidObjectId(id)) return reply.code(400).send(errorResponse("Invalid prescription ID"));

    const prescription = await Prescription.findById(id);
    if (!prescription) return reply.code(404).send(errorResponse("Prescription not found"));

    const access = await checkOperationalRecordAccess(req, prescription);
    if (!access.allowed) return sendTenantError(reply, access);

    if (req.user?.role === "doctor" && prescription.doctorId.toString() !== userId) {
      return reply.code(403).send(errorResponse("Only the prescribing doctor can amend this prescription"));
    }

    const {
      medicineName,
      dosage,
      frequency,
      duration,
      instructions,
      amendmentReason,
      registrationNumber,
      council,
      diagnosisCode,
      diagnosisDescription,
    } = req.body as any;

    if (!amendmentReason || !amendmentReason.trim()) {
      return reply.code(400).send(errorResponse("amendmentReason is required to amend a sealed prescription"));
    }

    const { PrescriptionSealingService } = await import("../services/PrescriptionSealingService.ts");
    const newSealed = await PrescriptionSealingService.amendPrescription(id, userId, {
      medicineName,
      dosage,
      frequency,
      duration,
      instructions,
      amendmentReason,
      registrationNumber,
      council,
      diagnosisCode,
      diagnosisDescription,
    });

    return reply.code(201).send(successResponse(newSealed, "Prescription successfully amended and cryptographically sealed"));
  } catch (err: any) {
    console.error("amendPrescriptionController error:", err);
    return reply.code(500).send(errorResponse(err.message || "Failed to amend prescription"));
  }
}

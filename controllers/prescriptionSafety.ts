import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { Encounter } from "../models/Encounter.ts";
import { cdsEngine } from "../services/CDSEngine.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkClinicAccess, checkOperationalRecordAccess, checkPatientAccess, resolveTargetOrganizationId } from "../utilities/tenant.ts";

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
      clinicId,
      encounterId,
      patientId,
      prescriptionIds,
      findings,
      clinicianDecision,
      overrideReason,
    } = req.body as {
      clinicId: string;
      encounterId?: string;
      patientId: string;
      prescriptionIds?: string[];
      findings: any[];
      clinicianDecision: "accepted" | "overridden" | "blocked";
      overrideReason?: string;
    };

    if (!patientId || !clinicId || !clinicianDecision) {
      return reply.code(400).send(errorResponse("clinicId, patientId and clinicianDecision are required"));
    }

    if (!mongoose.isValidObjectId(patientId) || !mongoose.isValidObjectId(clinicId)) {
      return reply.code(400).send(errorResponse("Invalid patient or clinic ID"));
    }
    const clinicAccess = await checkClinicAccess(req, clinicId);
    if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);

    if (!orgId && clinicAccess.organizationId) {
      orgId = clinicAccess.organizationId;
    }
    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));
    if (clinicAccess.organizationId && clinicAccess.organizationId !== orgId && req.user?.role !== "root") {
      return reply.code(403).send(errorResponse("Clinic does not belong to the active organization"));
    }
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);

    if (encounterId) {
      if (!mongoose.isValidObjectId(encounterId)) return reply.code(400).send(errorResponse("Invalid encounter ID"));
      const encounter = await Encounter.findById(encounterId).lean();
      if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
      const encounterAccess = await checkOperationalRecordAccess(req, encounter);
      if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);
      if (encounter.patientId?.toString() !== patientId || encounter.clinicId?.toString() !== clinicId) {
        return reply.code(400).send(errorResponse("Encounter does not match the selected patient and clinic"));
      }
    }

    if (clinicianDecision === "overridden" && (!overrideReason || !overrideReason.trim())) {
      return reply.code(400).send(errorResponse("overrideReason is required when overriding safety findings"));
    }

    const evaluationDoc = await CDSEvaluation.create({
      organizationId: orgId,
      clinicId,
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

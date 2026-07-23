import type { FastifyRequest, FastifyReply } from "fastify";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { cdsEngine } from "../services/CDSEngine.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function evaluatePrescriptionSafetyController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, proposedPrescriptions } = req.body as {
      patientId: string;
      proposedPrescriptions: Array<{ medicineName: string; medicineId?: string; dosage?: string }>;
    };

    if (!patientId || !Array.isArray(proposedPrescriptions)) {
      return reply.code(400).send(errorResponse("patientId and proposedPrescriptions array are required"));
    }

    const patient = await Patient.findById(patientId).lean();
    if (!patient) return reply.code(404).send(errorResponse("Patient not found"));

    // Fetch active prescriptions across recent encounters
    const activePrescriptions = await Prescription.find({
      patientId,
      status: "active",
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

export async function overrideCDSEvaluationController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
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

    if (!orgId) return reply.code(403).send(errorResponse("Organization context required"));
    if (!patientId || !clinicianDecision) {
      return reply.code(400).send(errorResponse("patientId and clinicianDecision are required"));
    }

    if (clinicianDecision === "overridden" && (!overrideReason || !overrideReason.trim())) {
      return reply.code(400).send(errorResponse("overrideReason is required when overriding safety findings"));
    }

    const evaluationDoc = await CDSEvaluation.create({
      organizationId: orgId,
      clinicId: clinicId || "000000000000000000000000",
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

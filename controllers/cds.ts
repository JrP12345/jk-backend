import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { evaluateClinicalDecisionSupport } from "../services/ClinicalDecisionSupportService.ts";
import { cdsEngine } from "../services/CDSEngine.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { checkClinicAccess, checkPatientAccess, getRequestClinicIds } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, result: { statusCode: number; message: string }) {
  return reply.code(result.statusCode).send(errorResponse(result.message));
}

export async function checkCdsSafety(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, prescribedMedications } = req.body as {
      patientId: string;
      prescribedMedications: Array<{ name: string; dosage?: string }>;
    };

    if (!patientId || !mongoose.isValidObjectId(patientId) || !prescribedMedications || !Array.isArray(prescribedMedications)) {
      return reply.code(400).send(errorResponse("patientId and prescribedMedications array are required"));
    }

    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);

    // 1. Fetch patient document and active prescriptions for full engine evaluation
    const patientDoc = await Patient.findById(patientId).lean();
    const activePrescriptions = await Prescription.find({ patientId, status: "active" }).lean();

    const engineContext = {
      patient: {
        id: patientId,
        age: patientDoc?.dob ? Math.floor((Date.now() - new Date(patientDoc.dob).getTime()) / (365.25 * 24 * 60 * 60 * 1000)) : 45,
        gender: patientDoc?.gender || "unknown",
        allergies: patientDoc?.allergies || [],
        conditions: [],
      },
      activeMedications: activePrescriptions.map((p) => ({
        medicineName: p.medicineName,
        dosage: p.dosage,
      })),
      proposedPrescriptions: prescribedMedications.map((m) => ({
        medicineName: m.name,
        dosage: m.dosage,
      })),
    };

    // 2. Evaluate using CDSEngine orchestrator & ClinicalDecisionSupportService
    const engineResult = await cdsEngine.evaluate(engineContext as any);
    const serviceAlerts = await evaluateClinicalDecisionSupport(patientId, prescribedMedications);

    const combinedAlerts = [
      ...serviceAlerts,
      ...engineResult.findings.map((f) => ({
        severity: f.severity === "critical" ? ("critical" as const) : f.severity === "moderate" ? ("warning" as const) : ("info" as const),
        title: f.title,
        description: f.description,
        recommendation: f.recommendation,
        findingType: f.findingType,
        offendingItems: f.offendingItems,
      })),
    ];

    // Deduplicate alerts by title
    const uniqueAlerts = Array.from(
      new Map(combinedAlerts.map((item) => [item.title.toLowerCase(), item])).values()
    );

    return reply.code(200).send(
      successResponse({
        alertsCount: uniqueAlerts.length,
        hasCriticalAlerts: uniqueAlerts.some((a) => a.severity === "critical"),
        alerts: uniqueAlerts,
        engineMetrics: engineResult.metrics,
        datasetVersion: engineResult.datasetVersion,
      })
    );
  } catch (err) {
    console.error("checkCdsSafety error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getCdsEvaluations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, patientId } = req.query as { clinicId?: string; patientId?: string };
    const filter: any = {};
    if (clinicId) {
      if (!mongoose.isValidObjectId(clinicId)) return reply.code(400).send(errorResponse("Invalid clinic ID"));
      const clinicAccess = await checkClinicAccess(req, clinicId);
      if (!clinicAccess.allowed) return sendTenantError(reply, clinicAccess);
      filter.clinicId = clinicId;
    } else {
      const clinicIds = await getRequestClinicIds(req);
      if (clinicIds) filter.clinicId = { $in: clinicIds };
    }
    if (patientId) {
      if (!mongoose.isValidObjectId(patientId)) return reply.code(400).send(errorResponse("Invalid patient ID"));
      const patientAccess = await checkPatientAccess(req, patientId);
      if (!patientAccess.allowed) return sendTenantError(reply, patientAccess);
      filter.patientId = patientId;
    }

    const evaluations = await CDSEvaluation.find(filter)
      .populate({ path: "patientId", populate: { path: "userId", select: "name email" } })
      .sort({ evaluatedAt: -1 })
      .limit(50);

    return reply.code(200).send(successResponse(evaluations));
  } catch (err) {
    console.error("getCdsEvaluations error:", err);
    return reply.code(500).send(errorResponse("Failed to fetch CDS evaluations"));
  }
}

export async function getCdsRules(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const rules = [
      {
        ruleId: "DRUG-INTERACTION-001",
        name: "Drug-Drug Interaction Matrix Engine",
        category: "DRUG_INTERACTION",
        version: "2026.07.22",
        status: "ACTIVE",
        evidence: "FDA Black Box Warning & CHEST Guidelines",
        description: "Screens concurrent prescription pairs against clinical interaction database for hemorrhage, hyperkalemia, and absorption risk.",
        samplePairs: ["Warfarin + Aspirin", "Lisinopril + Spironolactone", "Ciprofloxacin + Antacid", "Sildenafil + Nitroglycerin"],
      },
      {
        ruleId: "ALLERGY-001",
        name: "Patient Allergy Cross-Reference Rule",
        category: "ALLERGY",
        version: "1.0.0",
        status: "ACTIVE",
        evidence: "Patient Documented Allergy Registry & SNOMED CT Cross-Reactivity",
        description: "Cross-references proposed antimicrobial and pharmaceutical agents against documented patient drug hypersensitivities.",
        samplePairs: ["Penicillin -> Amoxicillin", "Sulfonamide -> Trimethoprim-Sulfamethoxazole"],
      },
      {
        ruleId: "DUPLICATE-THERAPY-001",
        name: "Duplicate Therapeutic Class Rule",
        category: "DUPLICATE_THERAPY",
        version: "1.0.0",
        status: "ACTIVE",
        evidence: "Pharmacotherapeutic Duplicate Ingredient Detection",
        description: "Identifies duplicate active pharmaceutical ingredients prescribed concurrently under different brand names.",
        samplePairs: ["Crocin + Paracetamol", "Tylenol + Acetaminophen"],
      },
      {
        ruleId: "RENAL-DOSE-001",
        name: "eGFR Renal Impairment Dosage Adjuster",
        category: "RENAL_DOSE",
        version: "1.2.0",
        status: "ACTIVE",
        evidence: "KDIGO Clinical Practice Guideline for Acute Kidney Injury",
        description: "Calculates dosage limits and administration frequency adjustments for patients with eGFR < 30 mL/min.",
        samplePairs: ["Metformin + eGFR < 30", "Enoxaparin + Severe CrCl"],
      },
    ];

    return reply.code(200).send(successResponse(rules));
  } catch (err) {
    console.error("getCdsRules error:", err);
    return reply.code(500).send(errorResponse("Failed to fetch CDS rules"));
  }
}

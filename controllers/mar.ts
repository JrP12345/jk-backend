import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Encounter } from "../models/Encounter.ts";
import { MedicationAdministration } from "../models/MedicationAdministration.ts";
import { Prescription } from "../models/Prescription.ts";
import { MARService } from "../services/MARService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkOperationalRecordAccess } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

/**
 * POST /api/encounters/:id/mar
 * Schedule a new dose administration entry from an active prescription.
 * Permission: ADMINISTER_MEDICATION
 */
export async function scheduleMARController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const userId = req.user?.id!;
    const {
      prescriptionId,
      route,
      scheduledTime,
      notes,
      observationId,
    } = req.body as {
      prescriptionId: string;
      route: string;
      scheduledTime: string;
      notes?: string;
      observationId?: string;
    };

    if (!prescriptionId || !route || !scheduledTime) {
      return reply.code(400).send(errorResponse("prescriptionId, route, and scheduledTime are required"));
    }

    const encounter = await Encounter.findById(encounterId).lean() as any;
    if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
    const encounterAccess = await checkOperationalRecordAccess(req, encounter);
    if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);

    if (!mongoose.Types.ObjectId.isValid(prescriptionId)) {
      return reply.code(400).send(errorResponse("Invalid prescription ID"));
    }
    const prescription = await Prescription.findById(prescriptionId).lean() as any;
    if (!prescription) return reply.code(404).send(errorResponse("Prescription not found"));
    const prescriptionAccess = await checkOperationalRecordAccess(req, prescription);
    if (!prescriptionAccess.allowed) return sendTenantError(reply, prescriptionAccess);
    if (prescription.encounterId?.toString() !== encounterId || prescription.patientId?.toString() !== encounter.patientId?.toString() || prescription.clinicId?.toString() !== encounter.clinicId?.toString()) {
      return reply.code(400).send(errorResponse("Prescription does not belong to the selected encounter"));
    }
    if (prescription.status !== "active") {
      return reply.code(400).send(errorResponse("Only active prescriptions can be scheduled on the MAR"));
    }

    const doc = await MARService.scheduleAdministration({
      organizationId: encounter.organizationId?.toString(),
      clinicId:       encounter.clinicId?.toString(),
      encounterId,
      prescriptionId,
      patientId:      encounter.patientId?.toString(),
      route:          route as "oral" | "iv" | "im" | "topical" | "inhaled" | "sublingual" | "rectal" | "other",
      scheduledTime:  new Date(scheduledTime),
      recordedBy:     userId,
      notes,
      observationId,
    });

    return reply.code(201).send(successResponse(doc, "Medication administration scheduled"));
  } catch (err: any) {
    const statusCode = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(statusCode).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/encounters/:id/mar
 * Retrieve the full MAR for an encounter, grouped by prescription.
 * Permission: VIEW_EHR
 */
export async function getEncounterMARController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const encounter = await Encounter.findById(encounterId).lean() as any;
    if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
    const encounterAccess = await checkOperationalRecordAccess(req, encounter);
    if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);
    const { entries, grouped } = await MARService.getMAR(encounterId);
    return reply.code(200).send(successResponse({ entries, grouped }));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/mar/:id/administer
 * Record a dose as administered. Transitions: scheduled → administered.
 * Permission: ADMINISTER_MEDICATION
 */
export async function administerMARController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: administrationId } = req.params as { id: string };
    const userId = req.user?.id!;
    const { doseGiven, administeredTime, notes, observationId } = (req.body || {}) as {
      doseGiven?: string;
      administeredTime?: string;
      notes?: string;
      observationId?: string;
    };

    const existing = await MedicationAdministration.findById(administrationId).lean() as any;
    if (!existing) return reply.code(404).send(errorResponse("Medication administration record not found"));
    const recordAccess = await checkOperationalRecordAccess(req, existing);
    if (!recordAccess.allowed) return sendTenantError(reply, recordAccess);

    const doc = await MARService.recordAdministration(administrationId, {
      administeredBy: userId,
      recordedBy:     userId,
      doseGiven,
      administeredTime: administeredTime ? new Date(administeredTime) : undefined,
      notes,
      observationId,
    });

    return reply.code(200).send(successResponse(doc, "Dose recorded as administered"));
  } catch (err: any) {
    const statusCode = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(statusCode).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/mar/:id/refuse
 * Record patient refusal. Transitions: scheduled → refused.
 * Permission: ADMINISTER_MEDICATION
 */
export async function refuseMARController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: administrationId } = req.params as { id: string };
    const userId = req.user?.id!;
    const { refusalReason, notes } = (req.body || {}) as {
      refusalReason?: string;
      notes?: string;
    };

    if (!refusalReason || refusalReason.trim().length === 0) {
      return reply.code(400).send(errorResponse("refusalReason is required"));
    }

    const existing = await MedicationAdministration.findById(administrationId).lean() as any;
    if (!existing) return reply.code(404).send(errorResponse("Medication administration record not found"));
    const recordAccess = await checkOperationalRecordAccess(req, existing);
    if (!recordAccess.allowed) return sendTenantError(reply, recordAccess);

    const doc = await MARService.recordRefusal(administrationId, {
      recordedBy:    userId,
      refusalReason,
      notes,
    });

    return reply.code(200).send(successResponse(doc, "Patient refusal recorded"));
  } catch (err: any) {
    const statusCode = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(statusCode).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/mar/:id/hold
 * Hold a scheduled dose. Transitions: scheduled → held.
 * Permission: ADMINISTER_MEDICATION
 */
export async function holdMARController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: administrationId } = req.params as { id: string };
    const userId = req.user?.id!;
    const { holdReason, notes } = (req.body || {}) as {
      holdReason?: string;
      notes?: string;
    };

    if (!holdReason || holdReason.trim().length === 0) {
      return reply.code(400).send(errorResponse("holdReason is required"));
    }

    const existing = await MedicationAdministration.findById(administrationId).lean() as any;
    if (!existing) return reply.code(404).send(errorResponse("Medication administration record not found"));
    const recordAccess = await checkOperationalRecordAccess(req, existing);
    if (!recordAccess.allowed) return sendTenantError(reply, recordAccess);

    const doc = await MARService.holdAdministration(administrationId, {
      recordedBy: userId,
      holdReason,
      notes,
    });

    return reply.code(200).send(successResponse(doc, "Dose held"));
  } catch (err: any) {
    const statusCode = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") || err.message?.includes("Invalid") ? 422
      : 500;
    return reply.code(statusCode).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/prescriptions/:id/mar
 * Fetch all MAR entries for a single prescription.
 * Permission: VIEW_EHR
 */
export async function getPrescriptionMARController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: prescriptionId } = req.params as { id: string };
    const prescription = await Prescription.findById(prescriptionId).lean() as any;
    if (!prescription) return reply.code(404).send(errorResponse("Prescription not found"));
    const prescriptionAccess = await checkOperationalRecordAccess(req, prescription);
    if (!prescriptionAccess.allowed) return sendTenantError(reply, prescriptionAccess);
    const entries = await MARService.getMARByPrescription(prescriptionId);
    return reply.code(200).send(successResponse(entries));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

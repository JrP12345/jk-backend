import type { FastifyRequest, FastifyReply } from "fastify";
import { DischargeSummaryService, type ClinicianInputPayload } from "../services/DischargeSummaryService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

/**
 * POST /api/encounters/:id/discharge/compile
 * Compiles or updates a draft discharge summary by aggregating across all 6 engines.
 * Permission: MANAGE_DISCHARGE_SUMMARY
 */
export async function compileDischargeSummaryController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const userId = req.user?.id!;

    const doc = await DischargeSummaryService.compile(encounterId, userId);
    return reply.code(201).send(successResponse(doc, "Discharge summary compiled successfully (draft)"));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404
      : err.message?.includes("Cannot") ? 422
      : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/encounters/:id/discharge
 * Retrieve the current discharge summary for an encounter.
 * Permission: VIEW_EHR
 */
export async function getDischargeSummaryByEncounterController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const doc = await DischargeSummaryService.getByEncounter(encounterId);
    if (!doc) return reply.code(404).send(errorResponse("No discharge summary found for this encounter"));
    return reply.code(200).send(successResponse(doc));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/discharge/:id/finalize
 * Finalize a discharge summary: validates clinicianInput, freezes aggregated snapshot,
 * generates SHA-256 snapshotHash, and closes the Encounter.
 * Permission: MANAGE_DISCHARGE_SUMMARY
 */
export async function finalizeDischargeSummaryController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: documentId } = req.params as { id: string };
    const clinicianInput = req.body as ClinicianInputPayload;

    if (!clinicianInput) {
      return reply.code(400).send(errorResponse("clinicianInput body is required"));
    }

    const doc = await DischargeSummaryService.finalize(documentId, clinicianInput);
    return reply.code(200).send(successResponse(doc, "Discharge summary finalized and encounter closed"));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404
      : err.message?.includes("required") ? 400
      : err.message?.includes("Cannot") ? 422
      : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * PUT /api/discharge/:id/countersign
 * Appends an optional countersignature to a finalized discharge document.
 * Permission: MANAGE_DISCHARGE_SUMMARY
 */
export async function countersignDischargeSummaryController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: documentId } = req.params as { id: string };
    const userId = req.user?.id!;

    const doc = await DischargeSummaryService.countersign(documentId, userId);
    return reply.code(200).send(successResponse(doc, "Discharge summary countersigned"));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404
      : err.message?.includes("Only finalized") ? 422
      : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/discharge/:id
 * Retrieve a discharge document by ID.
 * Permission: VIEW_EHR
 */
export async function getDischargeByIdController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: documentId } = req.params as { id: string };
    const doc = await DischargeSummaryService.getById(documentId);
    if (!doc) return reply.code(404).send(errorResponse("Discharge document not found"));
    return reply.code(200).send(successResponse(doc));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

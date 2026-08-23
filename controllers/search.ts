import type { FastifyRequest, FastifyReply } from "fastify";
import { ClinicalSearchService } from "../services/ClinicalSearchService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

/**
 * GET /api/patients/:id/search?q=...&category=...&limit=...&cursor=...
 * Cross-engine longitudinal clinical search for a patient record.
 * Permission: VIEW_EHR
 */
export async function searchPatientRecordController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: patientId } = req.params as { id: string };
    const { q, category, dateFrom, dateTo, limit, cursor } = req.query as {
      q?: string;
      category?: string;
      dateFrom?: string;
      dateTo?: string;
      limit?: string | number;
      cursor?: string;
    };

    const options = {
      q,
      category,
      dateFrom: dateFrom ? new Date(dateFrom) : undefined,
      dateTo: dateTo ? new Date(dateTo) : undefined,
      limit: limit ? Number(limit) : 20,
      cursor,
    };

    const results = await ClinicalSearchService.searchPatientRecord(patientId, options);
    return reply.code(200).send(successResponse(results));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

/**
 * GET /api/encounters/:id/summary-report
 * Generates an encounter clinical story summary report (vitals, NEWS2, MAR compliance, labs).
 * Permission: VIEW_EHR
 */
export async function getEncounterSummaryReportController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const report = await ClinicalSearchService.getEncounterSummaryReport(encounterId);
    return reply.code(200).send(successResponse(report));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(err.message || "Internal server error"));
  }
}

import { resolveTargetOrganizationId } from "../utilities/tenant.ts";

/**
 * GET /api/analytics/quality-metrics
 * Generates organization-wide quality metrics grouped by clinical domains.
 * Permission: VIEW_ANALYTICS
 */
export async function getOrganizationQualityMetricsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = await resolveTargetOrganizationId(req);
    if (!orgId) {
      return reply.code(403).send(errorResponse("Organization context is required"));
    }

    const metrics = await ClinicalSearchService.getQualityMetrics(orgId);
    return reply.code(200).send(successResponse(metrics));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

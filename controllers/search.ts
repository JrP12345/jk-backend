import type { FastifyRequest, FastifyReply } from "fastify";
import { ClinicalSearchService } from "../services/ClinicalSearchService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { checkPatientAccess, checkOperationalRecordAccess } from '../utilities/tenant.ts';
import { Encounter } from '../models/Encounter.ts';
import mongoose from 'mongoose';

/**
 * GET /api/patients/:id/search?q=...&category=...&limit=...&cursor=...
 * Cross-engine longitudinal clinical search for a patient record.
 * Permission: VIEW_EHR
 */
export async function searchPatientRecordController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: patientId } = req.params as { id: string };
    const access = await checkPatientAccess(req, patientId);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const { q, category, dateFrom, dateTo, limit, cursor } = req.query as {
      q?: string;
      category?: string;
      dateFrom?: string;
      dateTo?: string;
      limit?: string | number;
      cursor?: string;
    };

    if (q !== undefined && (typeof q !== 'string' || q.length > 200)) return reply.code(400).send(errorResponse('Search query is too long'));
    if ((limit !== undefined && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)) || (cursor && cursor.length > 512) || (category && !['all', 'notes', 'observation', 'lab'].includes(category))) return reply.code(400).send(errorResponse('Invalid search pagination or category'));
    if ((dateFrom && !Number.isFinite(new Date(dateFrom).getTime())) || (dateTo && !Number.isFinite(new Date(dateTo).getTime()))) return reply.code(400).send(errorResponse('Invalid search dates'));
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
    return reply.code(500).send(errorResponse("Clinical search failed"));
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
    if (!mongoose.Types.ObjectId.isValid(encounterId)) return reply.code(400).send(errorResponse('Invalid encounter ID'));
    const encounter = await Encounter.findById(encounterId).select('patientId clinicId organizationId').lean()
      || await Encounter.findOne({ appointmentId: encounterId }).select('patientId clinicId organizationId').lean();
    if (!encounter) return reply.code(404).send(errorResponse('Encounter not found'));
    const patientAccess = await checkPatientAccess(req, encounter.patientId.toString());
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));
    if (!['patient', 'family_member'].includes(req.user!.role)) {
      const recordAccess = await checkOperationalRecordAccess(req, encounter);
      if (!recordAccess.allowed) return reply.code(recordAccess.statusCode).send(errorResponse(recordAccess.message));
    }
    const report = await ClinicalSearchService.getEncounterSummaryReport(encounter._id.toString());
    return reply.code(200).send(successResponse(report));
  } catch (err: any) {
    const code = err.message?.includes("not found") ? 404 : 500;
    return reply.code(code).send(errorResponse(code === 404 ? 'Encounter not found' : 'Encounter report failed'));
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
    return reply.code(500).send(errorResponse('Quality metrics failed'));
  }
}

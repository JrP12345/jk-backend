import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Encounter } from "../models/Encounter.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { ObservationAlert } from "../models/ObservationAlert.ts";
import { ObservationAnalyticsService } from "../services/ObservationAnalyticsService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { Patient } from "../models/Patient.ts";
import { checkOperationalRecordAccess, checkPatientAccess, getRequestLocationIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";

function sendTenantError(reply: FastifyReply, check: { allowed: false; statusCode: number; message: string }) {
  return reply.code(check.statusCode).send(errorResponse(check.message));
}

export async function evaluateEncounterScoreController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const { algorithmId = "NEWS2" } = (req.body || {}) as { algorithmId?: string };
    if (!mongoose.isValidObjectId(encounterId)) return reply.code(400).send(errorResponse("Invalid encounter ID"));

    const encounter = await Encounter.findById(encounterId).lean();
    if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
    const encounterAccess = await checkOperationalRecordAccess(req, encounter);
    if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);

    const scope = resolveAuthorizedOrganizationScope(req);
    const orgId = (scope.allowed ? scope.organizationId : undefined) || encounter.organizationId?.toString() || req.user?.organization_id || "";
    const locationId = encounter.locationId?.toString();
    const patientId = encounter.patientId?.toString();

    const { scoreDoc, alertDoc } = await ObservationAnalyticsService.evaluateEncounterScore(
      orgId,
      locationId,
      encounterId,
      patientId,
      algorithmId,
      req.user?.id
    );

    return reply.code(201).send(
      successResponse({ score: scoreDoc, alert: alertDoc }, "Clinical deterioration score evaluated and persisted")
    );
  } catch (err: any) {
    console.error("evaluateEncounterScoreController error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

export async function getEncounterScoresController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    if (!mongoose.isValidObjectId(encounterId)) return reply.code(400).send(errorResponse("Invalid encounter ID"));
    const encounter = await Encounter.findById(encounterId).lean();
    if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));
    if (["patient", "family_member"].includes(req.user!.role)) {
      const patientAccess = await checkPatientAccess(req, encounter.patientId.toString());
      if (!patientAccess.allowed) return reply.code(404).send(errorResponse("Encounter not found"));
    }
    const encounterAccess = await checkOperationalRecordAccess(req, encounter);
    if (!encounterAccess.allowed) return sendTenantError(reply, encounterAccess);
    const scores = await ObservationScore.find({ encounterId, organizationId: encounter.organizationId, patientId: encounter.patientId }).sort({ evaluatedAt: -1 }).lean();
    return reply.code(200).send(successResponse(scores));
  } catch (err) {
    console.error("getEncounterScoresController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function acknowledgeAlertController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: alertId } = req.params as { id: string };
    const userId = req.user?.id;
    const { action = "acknowledge" } = (req.body || {}) as { action?: "acknowledge" | "resolve" };

    const alertDoc = await ObservationAlert.findById(alertId);
    if (!alertDoc) return reply.code(404).send(errorResponse("Observation alert not found"));
    const alertAccess = await checkOperationalRecordAccess(req, alertDoc);
    if (!alertAccess.allowed) return sendTenantError(reply, alertAccess);
    if (!userId) return reply.code(401).send(errorResponse("Unauthorized"));
    if (!(["open", "acknowledged"].includes(alertDoc.status))) {
      return reply.code(400).send(errorResponse("Only open or acknowledged alerts can be updated"));
    }
    if (action !== "acknowledge" && action !== "resolve") {
      return reply.code(400).send(errorResponse("Action must be acknowledge or resolve"));
    }

    if (action === "resolve") {
      alertDoc.status = "resolved";
      alertDoc.resolvedAt = new Date();
    } else {
      alertDoc.status = "acknowledged";
      alertDoc.acknowledgedBy = userId as any;
      alertDoc.acknowledgedAt = new Date();
    }

    await alertDoc.save();
    return reply.code(200).send(successResponse(alertDoc, `Alert status updated to '${alertDoc.status}'`));
  } catch (err) {
    console.error("acknowledgeAlertController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPatientVitalTrendsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: patientId } = req.params as { id: string };
    const { days } = req.query as { days?: string };
    const daysNum = days ? Number(days) : 30;
    if (!Number.isInteger(daysNum) || daysNum < 1 || daysNum > 365) {
      return reply.code(400).send(errorResponse("days must be an integer between 1 and 365"));
    }
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed && req.user?.role !== "patient") return sendTenantError(reply, patientAccess);
    if (req.user?.role === "patient") {
      const patient = await Patient.findOne({ _id: patientId, userId: req.user.id }).select("_id").lean();
      if (!patient) return reply.code(404).send(errorResponse("Patient not found"));
    }

    let staffScope: { organizationId: string; locationIds: string[] } | null = null;
    if (!["root", "patient", "family_member"].includes(req.user!.role)) {
      const scope = resolveAuthorizedOrganizationScope(req);
      if (!scope.allowed) return sendTenantError(reply, scope);
      if (!scope.organizationId) return reply.code(403).send(errorResponse("Organization context required"));
      staffScope = { organizationId: scope.organizationId, locationIds: (await getRequestLocationIds(req) || []).map(String) };
    }
    // Portal ownership was checked above; only the patient/family and root may
    // receive the authorized patient's history across organizations.
    const trends = await ObservationAnalyticsService.getPatientVitalTrends(patientId, daysNum, staffScope);
    return reply.code(200).send(successResponse(trends));
  } catch (err) {
    console.error("getPatientVitalTrendsController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

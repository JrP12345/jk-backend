import type { FastifyRequest, FastifyReply } from "fastify";
import { Encounter } from "../models/Encounter.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { ObservationAlert } from "../models/ObservationAlert.ts";
import { ObservationAnalyticsService } from "../services/ObservationAnalyticsService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function evaluateEncounterScoreController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id: encounterId } = req.params as { id: string };
    const { algorithmId = "NEWS2" } = (req.body || {}) as { algorithmId?: string };

    const encounter = await Encounter.findById(encounterId).lean();
    if (!encounter) return reply.code(404).send(errorResponse("Encounter not found"));

    const orgId = req.user?.organization_id || encounter.organizationId?.toString();
    const clinicId = encounter.clinicId?.toString();
    const patientId = encounter.patientId?.toString();

    const { scoreDoc, alertDoc } = await ObservationAnalyticsService.evaluateEncounterScore(
      orgId,
      clinicId,
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
    const scores = await ObservationScore.find({ encounterId }).sort({ evaluatedAt: -1 }).lean();
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

    const trends = await ObservationAnalyticsService.getPatientVitalTrends(patientId, daysNum);
    return reply.code(200).send(successResponse(trends));
  } catch (err) {
    console.error("getPatientVitalTrendsController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

import type { FastifyRequest, FastifyReply } from "fastify";
import { evaluatePecCondition } from "../services/PecAdjudicationService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function evaluatePecClaim(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { policyStartDate, diagnosisCode, diagnosisDate, customWaitingPeriodMonths } = req.body as {
      policyStartDate: string;
      diagnosisCode: string;
      diagnosisDate?: string;
      customWaitingPeriodMonths?: number;
    };

    if (!policyStartDate || !diagnosisCode) {
      return reply.code(400).send(errorResponse("policyStartDate and diagnosisCode are required"));
    }

    const evaluation = evaluatePecCondition({
      policyStartDate,
      diagnosisCode,
      diagnosisDate,
      customWaitingPeriodMonths,
    });

    return reply.code(200).send(successResponse(evaluation, evaluation.isCovered ? "Claim covered under policy" : "Claim subject to PEC waiting period exclusion"));
  } catch (err) {
    console.error("evaluatePecClaim error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

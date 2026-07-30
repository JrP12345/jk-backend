import type { FastifyRequest, FastifyReply } from "fastify";
import { evaluateClinicalDecisionSupport } from "../services/ClinicalDecisionSupportService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function checkCdsSafety(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, prescribedMedications } = req.body as {
      patientId: string;
      prescribedMedications: Array<{ name: string; dosage?: string }>;
    };

    if (!prescribedMedications || !Array.isArray(prescribedMedications)) {
      return reply.code(400).send(errorResponse("prescribedMedications array is required"));
    }

    const alerts = await evaluateClinicalDecisionSupport(patientId, prescribedMedications);
    return reply.code(200).send(
      successResponse({
        alertsCount: alerts.length,
        hasCriticalAlerts: alerts.some((a) => a.severity === "critical"),
        alerts,
      })
    );
  } catch (err) {
    console.error("checkCdsSafety error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

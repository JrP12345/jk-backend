import type { FastifyRequest, FastifyReply } from "fastify";
import { aiObservabilityService } from "../services/ai/AIObservabilityService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// ─── GET /api/ai/observability/metrics ──────────────────────────────────
export async function getAIObservabilityMetricsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id || "";
    const summary = await aiObservabilityService.getOrganizationSummary(orgId, req.user?.id);
    return reply.code(200).send(successResponse(summary, "AI Observability metrics retrieved successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to retrieve AI observability metrics"));
  }
}

// ─── GET /api/ai/observability/costs ────────────────────────────────────
export async function getAICostAnalyticsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id || "";
    const summary = await aiObservabilityService.getOrganizationSummary(orgId, req.user?.id);

    const costBreakdown = {
      organizationId: orgId,
      monthlyTokenBudget: 5000000,
      totalTokensUsed: summary.totalInputTokens + summary.totalOutputTokens,
      estimatedSpendUSD: summary.totalEstimatedCostUSD,
      budgetUtilizationPercent: Number((((summary.totalInputTokens + summary.totalOutputTokens) / 5000000) * 100).toFixed(2))
    };

    return reply.code(200).send(successResponse(costBreakdown, "AI cost analytics breakdown retrieved successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to retrieve AI cost analytics"));
  }
}

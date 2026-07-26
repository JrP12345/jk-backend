import mongoose from "mongoose";
import { AIObservabilityMetric } from "../../models/AIObservabilityMetric.ts";

export interface OrganizationTelemetrySummary {
  organizationId: string;
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalEstimatedCostUSD: number;
  avgLatencyMs: number;
  failoverCount: number;
  errorCount: number;
  providerBreakdown: Record<string, number>;
}

export class AIObservabilityService {
  private static instance: AIObservabilityService;

  private constructor() {}

  static getInstance(): AIObservabilityService {
    if (!AIObservabilityService.instance) {
      AIObservabilityService.instance = new AIObservabilityService();
    }
    return AIObservabilityService.instance;
  }

  /**
   * Aggregates real-time telemetry metrics for an organization.
   */
  async getOrganizationSummary(organizationId: string, userId?: string): Promise<OrganizationTelemetrySummary> {
    const filterConditions: any[] = [];
    if (organizationId && mongoose.Types.ObjectId.isValid(organizationId)) {
      filterConditions.push({ organizationId: new mongoose.Types.ObjectId(organizationId) });
    }
    if (userId && mongoose.Types.ObjectId.isValid(userId)) {
      filterConditions.push({ userId: new mongoose.Types.ObjectId(userId) });
    }

    const filter = filterConditions.length > 0 ? { $or: filterConditions } : {};
    const metrics = await AIObservabilityMetric.find(filter).lean();

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalEstimatedCostUSD = 0;
    let totalLatency = 0;
    let failoverCount = 0;
    let errorCount = 0;
    const providerBreakdown: Record<string, number> = {};

    metrics.forEach(m => {
      totalInputTokens += m.inputTokens || 0;
      totalOutputTokens += m.outputTokens || 0;
      totalEstimatedCostUSD += m.estimatedCostUSD || 0;
      totalLatency += m.latencyMs || 0;

      if (m.status === "failover") failoverCount++;
      if (m.status === "error") errorCount++;

      const prov = m.provider || "Unknown";
      providerBreakdown[prov] = (providerBreakdown[prov] || 0) + 1;
    });

    const totalRequests = metrics.length;
    const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatency / totalRequests) : 0;

    return {
      organizationId,
      totalRequests,
      totalInputTokens,
      totalOutputTokens,
      totalEstimatedCostUSD: Number(totalEstimatedCostUSD.toFixed(6)),
      avgLatencyMs,
      failoverCount,
      errorCount,
      providerBreakdown
    };
  }
}

export const aiObservabilityService = AIObservabilityService.getInstance();

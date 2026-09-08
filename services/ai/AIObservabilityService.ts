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

    const [aggResult] = await AIObservabilityMetric.aggregate([
      { $match: filter },
      {
        $facet: {
          summary: [
            {
              $group: {
                _id: null,
                totalRequests: { $sum: 1 },
                totalInputTokens: { $sum: "$inputTokens" },
                totalOutputTokens: { $sum: "$outputTokens" },
                totalEstimatedCostUSD: { $sum: "$estimatedCostUSD" },
                avgLatencyMs: { $avg: "$latencyMs" },
                failoverCount: {
                  $sum: { $cond: [{ $eq: ["$status", "failover"] }, 1, 0] }
                },
                errorCount: {
                  $sum: { $cond: [{ $eq: ["$status", "error"] }, 1, 0] }
                }
              }
            }
          ],
          providers: [
            {
              $group: {
                _id: "$provider",
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ]);

    const summaryRow = aggResult?.summary?.[0] || {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCostUSD: 0,
      avgLatencyMs: 0,
      failoverCount: 0,
      errorCount: 0
    };

    const providerBreakdown: Record<string, number> = {};
    (aggResult?.providers || []).forEach((p: any) => {
      providerBreakdown[p._id || "Unknown"] = p.count;
    });

    return {
      organizationId,
      totalRequests: summaryRow.totalRequests,
      totalInputTokens: summaryRow.totalInputTokens,
      totalOutputTokens: summaryRow.totalOutputTokens,
      totalEstimatedCostUSD: Number(Number(summaryRow.totalEstimatedCostUSD).toFixed(6)),
      avgLatencyMs: Math.round(summaryRow.avgLatencyMs || 0),
      failoverCount: summaryRow.failoverCount,
      errorCount: summaryRow.errorCount,
      providerBreakdown
    };
  }
}

export const aiObservabilityService = AIObservabilityService.getInstance();

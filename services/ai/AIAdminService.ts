import { AIOrganizationConfig } from "../../models/AIOrganizationConfig.ts";

export class AIAdminService {
  private static instance: AIAdminService;

  private constructor() {}

  static getInstance(): AIAdminService {
    if (!AIAdminService.instance) {
      AIAdminService.instance = new AIAdminService();
    }
    return AIAdminService.instance;
  }

  /**
   * Fetches or initializes AI configuration for an organization.
   */
  async getConfig(organizationId: string) {
    if (!organizationId) {
      return {
        organizationId: "default",
        defaultModelAlias: "CLINICAL_FAST",
        monthlyTokenQuota: 10000000,
        featureFlags: {
          enableStreaming: true,
          enablePHIAnonymization: true,
          enableMultiAgentRouting: true,
          enableToolExecution: true
        }
      };
    }

    let config = await AIOrganizationConfig.findOne({ organizationId }).lean();
    if (!config) {
      config = await AIOrganizationConfig.create({
        organizationId,
        defaultModelAlias: "CLINICAL_FAST",
        monthlyTokenQuota: 10000000,
        featureFlags: {
          enableStreaming: true,
          enablePHIAnonymization: true,
          enableMultiAgentRouting: true,
          enableToolExecution: true
        }
      });
    }

    return config;
  }

  /**
   * Updates AI model preferences and feature flag configurations for an organization.
   */
  async updateConfig(organizationId: string, updates: any, userId?: string) {
    let config = await AIOrganizationConfig.findOne({ organizationId });
    if (!config) {
      config = new AIOrganizationConfig({ organizationId });
    }

    if (updates.defaultModelAlias) config.defaultModelAlias = updates.defaultModelAlias;
    if (updates.monthlyTokenQuota) config.monthlyTokenQuota = updates.monthlyTokenQuota;
    if (updates.featureFlags) {
      config.featureFlags = { ...config.featureFlags, ...updates.featureFlags };
    }
    if (userId) config.updatedByUserId = userId as any;

    await config.save();
    return config;
  }
}

export const aiAdminService = AIAdminService.getInstance();

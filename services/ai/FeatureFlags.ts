export interface AIFeatureConfig {
  enableStreaming: boolean;
  enablePHIAnonymization: boolean;
  enableMultiAgentRouting: boolean;
  enableToolExecution: boolean;
  enableClaudeProvider: boolean;
}

export class FeatureFlags {
  private static instance: FeatureFlags;
  private flags: AIFeatureConfig = {
    enableStreaming: true,
    enablePHIAnonymization: true,
    enableMultiAgentRouting: true,
    enableToolExecution: true,
    enableClaudeProvider: false
  };

  private constructor() {}

  static getInstance(): FeatureFlags {
    if (!FeatureFlags.instance) {
      FeatureFlags.instance = new FeatureFlags();
    }
    return FeatureFlags.instance;
  }

  getFlags(): AIFeatureConfig {
    return { ...this.flags };
  }

  isFeatureEnabled(feature: keyof AIFeatureConfig): boolean {
    return !!this.flags[feature];
  }

  setFeature(feature: keyof AIFeatureConfig, enabled: boolean): void {
    this.flags[feature] = enabled;
  }
}

export const featureFlags = FeatureFlags.getInstance();

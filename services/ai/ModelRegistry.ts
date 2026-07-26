import type { AIModelAlias } from "./AIProvider.ts";

export interface ModelMapping {
  alias: AIModelAlias;
  providerName: string;
  modelEndpoint: string;
  costPer1kTokensUSD: number;
}

export class ModelRegistry {
  private static instance: ModelRegistry;
  private mappings: Map<AIModelAlias, ModelMapping> = new Map();

  private constructor() {
    this.registerDefaults();
  }

  static getInstance(): ModelRegistry {
    if (!ModelRegistry.instance) {
      ModelRegistry.instance = new ModelRegistry();
    }
    return ModelRegistry.instance;
  }

  private registerDefaults() {
    this.mappings.set("CLINICAL_FAST", {
      alias: "CLINICAL_FAST",
      providerName: "GoogleGeminiAI",
      modelEndpoint: "gemini-flash-latest",
      costPer1kTokensUSD: 0.000075
    });

    this.mappings.set("CLINICAL_ACCURATE", {
      alias: "CLINICAL_ACCURATE",
      providerName: "OpenAICompatibleProvider",
      modelEndpoint: "gpt-4o",
      costPer1kTokensUSD: 0.0025
    });

    this.mappings.set("CLINICAL_REASONING", {
      alias: "CLINICAL_REASONING",
      providerName: "GoogleGeminiAI",
      modelEndpoint: "gemini-2.0-flash-001",
      costPer1kTokensUSD: 0.00015
    });
  }

  getModelMapping(alias: AIModelAlias): ModelMapping {
    return this.mappings.get(alias) || this.mappings.get("CLINICAL_FAST")!;
  }

  updateMapping(alias: AIModelAlias, mapping: ModelMapping): void {
    this.mappings.set(alias, mapping);
  }

  listModels(): ModelMapping[] {
    return Array.from(this.mappings.values());
  }
}

export const modelRegistry = ModelRegistry.getInstance();

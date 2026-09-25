import { describe, it, expect } from "vitest";
import { aiService } from "../services/ai/AIService.ts";
import { providerRegistry } from "../services/ai/ProviderRegistry.ts";
import { modelRegistry } from "../services/ai/ModelRegistry.ts";
import type { AIRequest, AIResponse, AIUsage } from "../services/ai/AIProvider.ts";

describe("Work Package A: Enterprise AI Contracts and Registries", () => {
  it("should verify ProviderRegistry registers and checks health of AI providers", async () => {
    const providers = providerRegistry.listProviders();
    expect(providers.length).toBeGreaterThanOrEqual(1);

    const primary = providerRegistry.getProvider();
    expect(primary).toBeDefined();
    expect(primary?.name).toBeDefined();

    const healthMap = await providerRegistry.checkHealth();
    expect(healthMap).toHaveProperty(primary!.name);
  });

  it("should verify ModelRegistry resolves abstract model aliases correctly", () => {
    const fastModel = modelRegistry.getModelMapping("CLINICAL_FAST");
    expect(fastModel.alias).toBe("CLINICAL_FAST");
    expect(fastModel.providerName).toBe("GoogleGeminiAI");
    expect(fastModel.modelEndpoint).toBe("gemini-1.5-flash");
    expect(fastModel.costPer1kTokensUSD).toBeGreaterThan(0);

    const accurateModel = modelRegistry.getModelMapping("CLINICAL_ACCURATE");
    expect(accurateModel.alias).toBe("CLINICAL_ACCURATE");
    expect(accurateModel.modelEndpoint).toBe("gpt-4o");

    const reasoningModel = modelRegistry.getModelMapping("CLINICAL_REASONING");
    expect(reasoningModel.alias).toBe("CLINICAL_REASONING");
  });

  it("should verify AI Contracts enforce mandatory correlationId and tracking fields", () => {
    const req: AIRequest = {
      correlationId: "corr_123456789",
      organizationId: "org_test",
      sessionId: "sess_test",
      requestId: "req_test",
      userId: "usr_test",
      modelAlias: "CLINICAL_FAST",
      prompt: "Audit patient roster"
    };

    const usage: AIUsage = {
      inputTokens: 150,
      outputTokens: 50,
      estimatedCostUSD: 0.000015,
      latencyMs: 120
    };

    const res: AIResponse = {
      correlationId: req.correlationId,
      text: "Patient roster verified.",
      citations: ["Hospital Registry"],
      usage,
      provider: "GoogleGeminiAI",
      model: "gemini-flash-latest"
    };

    expect(res.correlationId).toBe("corr_123456789");
    expect(res.usage.estimatedCostUSD).toBe(0.000015);
  });
});

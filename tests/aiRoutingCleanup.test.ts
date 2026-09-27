import { afterEach, describe, expect, it, vi } from "vitest";
import { aiGateway } from "../services/ai/AIGateway.ts";
import { InboundPipeline } from "../services/ai/InboundPipeline.ts";
import { providerRegistry } from "../services/ai/ProviderRegistry.ts";
import { AIObservabilityMetric } from "../models/AIObservabilityMetric.ts";
import type { AIRequest } from "../services/ai/AIProvider.ts";

const request: AIRequest = { correlationId: "cleanup", organizationId: "", userId: "", sessionId: "test", requestId: "r1", modelAlias: "CLINICAL_FAST", prompt: "Explain clinic scheduling", dataClassification: "nonclinical" };
const context = { anonymizedPrompt: request.prompt, anonymizedContext: "", compiledPrompt: {}, tokenMap: new Map(), providerName: "GoogleGeminiAI", modelEndpoint: "selected-gemini-model", enableStreaming: true, allowedProviders: [] as string[], privacyClassification: "nonclinical", dataCategoriesDisclosed: [], purpose: "administrative", retentionCategory: "transient" };
afterEach(() => vi.restoreAllMocks());
describe("AI routing cleanup", () => {
  it("passes the selected model and reports the actual backup model on failover", async () => {
    const primary = { name: "GoogleGeminiAI", defaultModel: "default-gemini", queryPatientHealthAssistant: vi.fn().mockRejectedValue(new Error("unavailable")) };
    const backup = { name: "OpenAI", defaultModel: "configured-openai-model", queryPatientHealthAssistant: vi.fn().mockResolvedValue({ answer: "Scheduling guidance", citations: [] }) };
    vi.spyOn(InboundPipeline, "process").mockResolvedValue(context as any);
    vi.spyOn(providerRegistry, "getProvider").mockImplementation((name?: string) => (name === "OpenAI" ? backup : primary) as any);
    vi.spyOn(providerRegistry, "listProviders").mockReturnValue([primary.name, backup.name]);
    vi.spyOn(AIObservabilityMetric, "create").mockResolvedValue({} as any);
    const result = await aiGateway.execute({ ...request });
    expect(primary.queryPatientHealthAssistant.mock.calls[0][0].modelEndpoint).toBe("selected-gemini-model");
    expect(backup.queryPatientHealthAssistant.mock.calls[0][0].modelEndpoint).toBe("configured-openai-model");
    expect(result.provider).toBe("OpenAI");
    expect(result.model).toBe("configured-openai-model");
  });
  it("refuses streaming before provider execution when disabled", async () => {
    vi.spyOn(InboundPipeline, "process").mockResolvedValue({ ...context, enableStreaming: false } as any);
    const provider = vi.spyOn(providerRegistry, "getProvider");
    await expect(aiGateway.executeStream({ ...request }, vi.fn())).rejects.toThrow("streaming is disabled");
    expect(provider).not.toHaveBeenCalled();
  });
  it("does not fail over outside the tenant provider allowlist", async () => {
    const primary = { name: "GoogleGeminiAI", queryPatientHealthAssistant: vi.fn().mockRejectedValue(new Error("unavailable")) };
    const backup = { name: "OpenAI", queryPatientHealthAssistant: vi.fn() };
    vi.spyOn(InboundPipeline, "process").mockResolvedValue({ ...context, allowedProviders: [primary.name] } as any);
    vi.spyOn(providerRegistry, "getProvider").mockImplementation((name?: string) => (name === "OpenAI" ? backup : primary) as any);
    vi.spyOn(providerRegistry, "listProviders").mockReturnValue([primary.name, backup.name]);
    await expect(aiGateway.execute({ ...request })).rejects.toThrow("unavailable");
    expect(backup.queryPatientHealthAssistant).not.toHaveBeenCalled();
  });
});

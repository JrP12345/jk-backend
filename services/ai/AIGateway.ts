import type { AIRequest, AIResponse, AIUsage } from "./AIProvider.ts";
import { providerRegistry } from "./ProviderRegistry.ts";
import { modelRegistry } from "./ModelRegistry.ts";
import { InboundPipeline } from "./InboundPipeline.ts";
import { OutboundPipeline } from "./OutboundPipeline.ts";

export class AIGateway {
  private static instance: AIGateway;

  private constructor() {}

  static getInstance(): AIGateway {
    if (!AIGateway.instance) {
      AIGateway.instance = new AIGateway();
    }
    return AIGateway.instance;
  }

  /**
   * Main entrypoint for processing enterprise AI requests through the pipeline with provider failover.
   */
  async execute(request: AIRequest, samplePatientData?: Array<{ name?: string; mrn?: string; email?: string }>): Promise<AIResponse> {
    const startTime = Date.now();

    // 1. Run Inbound Pipeline
    const inboundContext = await InboundPipeline.process(request, samplePatientData);
    const { anonymizedPrompt, tokenMap, providerName, modelEndpoint } = inboundContext;

    // 2. Select Provider from ProviderRegistry
    let provider = providerRegistry.getProvider(providerName);
    if (!provider) {
      console.warn(`[AIGateway] Specified provider ${providerName} not found, falling back to primary provider.`);
      provider = providerRegistry.getProvider();
    }

    if (!provider) {
      throw new Error("[AIGateway] No available AI provider registered in ProviderRegistry");
    }

    try {
      // Execute request with provider passing full 6D context
      const queryRes = await provider.queryPatientHealthAssistant({
        patientId: request.sessionId || "general",
        query: anonymizedPrompt,
        patientRecordSummary: inboundContext.sixDContext.fullContextSummary
      });

      const latencyMs = Date.now() - startTime;
      const mapping = modelRegistry.getModelMapping(request.modelAlias);
      const estTokens = Math.ceil((anonymizedPrompt.length + queryRes.answer.length) / 4);

      const usage: AIUsage = {
        inputTokens: Math.ceil(anonymizedPrompt.length / 4),
        outputTokens: Math.ceil(queryRes.answer.length / 4),
        estimatedCostUSD: (estTokens / 1000) * mapping.costPer1kTokensUSD,
        latencyMs
      };

      // 3. Run Outbound Pipeline
      return await OutboundPipeline.process(
        queryRes.answer,
        request.correlationId,
        tokenMap,
        provider.name,
        mapping.modelEndpoint,
        usage,
        queryRes.citations
      );
    } catch (primaryErr: any) {
      console.warn(`[AIGateway] Primary provider ${provider.name} failed (${primaryErr.message}). Triggering failover fallback...`);
      
      const fallbackProvider = providerRegistry.getProvider("FallbackSimulationAI");
      if (!fallbackProvider) throw primaryErr;

      const fallbackRes = await fallbackProvider.queryPatientHealthAssistant({
        patientId: request.sessionId || "general",
        query: anonymizedPrompt,
        patientRecordSummary: inboundContext.sixDContext.fullContextSummary
      });

      const latencyMs = Date.now() - startTime;
      const usage: AIUsage = {
        inputTokens: Math.ceil(anonymizedPrompt.length / 4),
        outputTokens: Math.ceil(fallbackRes.answer.length / 4),
        estimatedCostUSD: 0,
        latencyMs
      };

      return await OutboundPipeline.process(
        fallbackRes.answer,
        request.correlationId,
        tokenMap,
        fallbackProvider.name,
        "simulation-fallback",
        usage,
        fallbackRes.citations
      );
    }
  }
}

export const aiGateway = AIGateway.getInstance();

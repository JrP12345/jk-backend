import type { AIRequest, AIResponse, AIUsage } from "./AIProvider.ts";
import { providerRegistry } from "./ProviderRegistry.ts";
import { modelRegistry } from "./ModelRegistry.ts";
import { InboundPipeline } from "./InboundPipeline.ts";
import { OutboundPipeline } from "./OutboundPipeline.ts";
import { AIServiceUnavailableError } from "./AIService.ts";

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
  async execute(
    request: AIRequest,
    samplePatientData?: Array<{ name?: string; mrn?: string; email?: string }>,
    extraContextInput?: { currentRoute?: string; activePatientId?: string; userRole?: string }
  ): Promise<AIResponse> {
    const startTime = Date.now();

    // 1. Run Inbound Pipeline
    const inboundContext = await InboundPipeline.process(request, samplePatientData, extraContextInput);
    const { anonymizedPrompt, tokenMap, providerName, modelEndpoint, compiledPrompt } = inboundContext;

    // 2. Select Provider from ProviderRegistry
    let provider = providerRegistry.getProvider(providerName);
    if (!provider) {
      console.warn(`[AIGateway] Specified provider ${providerName} not found, falling back to primary provider.`);
      provider = providerRegistry.getProvider();
    }

    if (!provider) {
      throw new Error("[AIGateway] No available AI provider registered in ProviderRegistry");
    }

    const payload = {
      patientId: request.sessionId || "general",
      query: anonymizedPrompt,
      patientRecordSummary: inboundContext.anonymizedContext || inboundContext.sixDContext.fullContextSummary,
      chatHistory: request.chatHistory,
      systemPrompt: compiledPrompt?.systemPrompt || request.systemDirective,
      compiledPromptText: compiledPrompt?.userPrompt
    };

    try {
      // Execute request with provider passing clean anonymized context and chat history
      const queryRes = await provider.queryPatientHealthAssistant(payload);

      const latencyMs = Date.now() - startTime;
      const mapping = modelRegistry.getModelMapping(request.modelAlias);
      const inTokens = queryRes.rawUsage?.inputTokens ?? Math.ceil(anonymizedPrompt.length / 4);
      const outTokens = queryRes.rawUsage?.outputTokens ?? Math.ceil(queryRes.answer.length / 4);

      const usage: AIUsage = {
        inputTokens: inTokens,
        outputTokens: outTokens,
        estimatedCostUSD: ((inTokens + outTokens) / 1000) * mapping.costPer1kTokensUSD,
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
      console.warn(`[AIGateway] Primary provider ${provider.name} failed (${primaryErr.message}).`);

      // Attempt real failover across registered production providers
      const backupProviders = providerRegistry.listProviders().filter(
        name => name !== provider!.name && name !== "FallbackSimulationAI" && name !== "AIProviderUnavailable"
      );

      for (const backupName of backupProviders) {
        const backupProvider = providerRegistry.getProvider(backupName);
        if (backupProvider) {
          try {
            console.log(`[AIGateway] Attempting real failover to backup provider: ${backupName}`);
            const backupRes = await backupProvider.queryPatientHealthAssistant(payload);
            const latencyMs = Date.now() - startTime;
            const mapping = modelRegistry.getModelMapping(request.modelAlias);
            const inTokens = backupRes.rawUsage?.inputTokens ?? Math.ceil(anonymizedPrompt.length / 4);
            const outTokens = backupRes.rawUsage?.outputTokens ?? Math.ceil((backupRes.answer || "").length / 4);

            const usage: AIUsage = {
              inputTokens: inTokens,
              outputTokens: outTokens,
              estimatedCostUSD: ((inTokens + outTokens) / 1000) * mapping.costPer1kTokensUSD,
              latencyMs
            };

            return await OutboundPipeline.process(
              backupRes.answer,
              request.correlationId,
              tokenMap,
              backupProvider.name,
              backupName,
              usage,
              backupRes.citations
            );
          } catch (bErr: any) {
            console.warn(`[AIGateway] Backup provider ${backupName} failed:`, bErr.message);
          }
        }
      }

      if (process.env.NODE_ENV === "production") {
        throw new AIServiceUnavailableError(`Clinical AI service temporarily unavailable: ${primaryErr?.message || "Gateway error"}`);
      }

      console.warn(`[AIGateway] Non-production environment triggering fallback simulation provider...`);
      const fallbackProvider = providerRegistry.getProvider("FallbackSimulationAI") || providerRegistry.getProvider("SimulationFallbackAI");
      if (!fallbackProvider) throw primaryErr;

      try {
        const fallbackRes = await fallbackProvider.queryPatientHealthAssistant(payload);

        const latencyMs = Date.now() - startTime;
        const usage: AIUsage = {
          inputTokens: Math.ceil(anonymizedPrompt.length / 4),
          outputTokens: Math.ceil((fallbackRes.answer || "").length / 4),
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
      } catch {
        throw primaryErr;
      }
    }
  }

  /**
   * Executes streaming AI requests delivering real tokens chunk-by-chunk to the client.
   */
  async executeStream(
    request: AIRequest,
    onChunk: (token: string) => void,
    samplePatientData?: Array<{ name?: string; mrn?: string; email?: string }>,
    extraContextInput?: { currentRoute?: string; activePatientId?: string; userRole?: string }
  ): Promise<AIResponse> {
    const startTime = Date.now();

    // 1. Run Inbound Pipeline
    const inboundContext = await InboundPipeline.process(request, samplePatientData, extraContextInput);
    const { anonymizedPrompt, tokenMap, providerName, modelEndpoint, compiledPrompt } = inboundContext;

    // 2. Select Provider from ProviderRegistry
    let provider = providerRegistry.getProvider(providerName);
    if (!provider) {
      provider = providerRegistry.getProvider();
    }

    if (!provider) {
      throw new Error("[AIGateway] No available AI provider registered in ProviderRegistry");
    }

    const streamHandler = (token: string) => {
      let rehydratedToken = token;
      tokenMap.forEach((realVal, placeholder) => {
        if (rehydratedToken.includes(placeholder)) {
          rehydratedToken = rehydratedToken.replaceAll(placeholder, realVal);
        }
      });
      onChunk(rehydratedToken);
    };

    const streamPayload = {
      patientId: request.sessionId || "general",
      query: anonymizedPrompt,
      patientRecordSummary: inboundContext.anonymizedContext || inboundContext.sixDContext.fullContextSummary,
      chatHistory: request.chatHistory,
      systemPrompt: compiledPrompt?.systemPrompt || request.systemDirective,
      compiledPromptText: compiledPrompt?.userPrompt
    };

    let streamRes: any;
    if (typeof provider.streamHealthAssistant === "function") {
      streamRes = await provider.streamHealthAssistant(streamPayload, streamHandler);
    } else {
      streamRes = await provider.queryPatientHealthAssistant(streamPayload);
      streamHandler(streamRes.answer);
    }

    const latencyMs = Date.now() - startTime;
    const mapping = modelRegistry.getModelMapping(request.modelAlias);
    const inTokens = streamRes.rawUsage?.inputTokens ?? Math.ceil(anonymizedPrompt.length / 4);
    const outTokens = streamRes.rawUsage?.outputTokens ?? Math.ceil((streamRes.answer || "").length / 4);

    const usage: AIUsage = {
      inputTokens: inTokens,
      outputTokens: outTokens,
      estimatedCostUSD: ((inTokens + outTokens) / 1000) * mapping.costPer1kTokensUSD,
      latencyMs
    };

    return await OutboundPipeline.process(
      streamRes.answer,
      request.correlationId,
      tokenMap,
      provider.name,
      mapping.modelEndpoint,
      usage,
      streamRes.citations
    );
  }
}

export const aiGateway = AIGateway.getInstance();


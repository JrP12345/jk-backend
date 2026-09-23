import type { AIRequest, AIResponse, AIUsage, SOAPGenerationInput, SOAPNoteDraft, HealthQueryInput, HealthQueryResponse } from "./AIProvider.ts";
import { providerRegistry } from "./ProviderRegistry.ts";
import { modelRegistry } from "./ModelRegistry.ts";
import { InboundPipeline } from "./InboundPipeline.ts";
import { OutboundPipeline } from "./OutboundPipeline.ts";
import { AIServiceUnavailableError } from "./AIService.ts";
import { AIDataPrivacyError } from "../../utilities/phiAnonymizer.ts";
import { AIObservabilityMetric } from "../../models/AIObservabilityMetric.ts";

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
   * Enforces fail-closed privacy controls, kill switch, and automated observability metric recording.
   */
  async execute(
    request: AIRequest,
    samplePatientData?: Array<{ name?: string; mrn?: string; email?: string; phone?: string }>,
    extraContextInput?: { currentRoute?: string; activePatientId?: string; userRole?: string }
  ): Promise<AIResponse> {
    const startTime = Date.now();

    let inboundContext;
    try {
      // 1. Run Inbound Pipeline (Kill switch, Classification, Mandatory Anonymization)
      inboundContext = await InboundPipeline.process(request, samplePatientData, extraContextInput);
    } catch (inboundErr: any) {
      // Audit blocked privacy/killswitch events
      const isKillSwitch = inboundErr?.message?.includes("kill switch");
      const status = isKillSwitch ? "blocked_killswitch" : (inboundErr instanceof AIDataPrivacyError ? "blocked_privacy" : "error");

      AIObservabilityMetric.create({
        correlationId: request.correlationId || `corr_err_${Date.now()}`,
        organizationId: request.organizationId || null,
        userId: request.userId || null,
        sessionId: request.sessionId || "general",
        provider: "gateway_firewall",
        model: "none",
        modelAlias: request.modelAlias || "CLINICAL_FAST",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUSD: 0,
        latencyMs: Date.now() - startTime,
        status,
        errorMessage: inboundErr.message,
        privacyClassification: request.dataClassification || "deidentified_clinical",
        purpose: request.purpose || "clinical_assistant",
        retentionCategory: request.retentionCategory || "operational_transient"
      }).catch(err => console.error("[AIGateway] Failed to log privacy block metric:", err));

      throw inboundErr;
    }

    const {
      anonymizedPrompt,
      tokenMap,
      providerName,
      modelEndpoint,
      compiledPrompt,
      privacyClassification,
      dataCategoriesDisclosed,
      purpose,
      retentionCategory
    } = inboundContext;

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
      const outboundRes = await OutboundPipeline.process(
        queryRes.answer,
        request.correlationId,
        tokenMap,
        provider.name,
        mapping.modelEndpoint,
        usage,
        queryRes.citations
      );

      outboundRes.dataCategoriesDisclosed = dataCategoriesDisclosed;
      outboundRes.privacyClassification = privacyClassification;

      // Asynchronously record success telemetry
      AIObservabilityMetric.create({
        correlationId: request.correlationId,
        organizationId: request.organizationId,
        userId: request.userId,
        sessionId: request.sessionId || "general",
        provider: provider.name,
        model: mapping.modelEndpoint,
        modelAlias: request.modelAlias,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        estimatedCostUSD: usage.estimatedCostUSD,
        latencyMs: usage.latencyMs,
        status: "success",
        privacyClassification,
        dataCategoriesDisclosed,
        purpose,
        retentionCategory
      }).catch(err => console.error("[AIGateway] Telemetry record error:", err));

      return outboundRes;
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

            const outboundRes = await OutboundPipeline.process(
              backupRes.answer,
              request.correlationId,
              tokenMap,
              backupProvider.name,
              backupName,
              usage,
              backupRes.citations
            );

            outboundRes.dataCategoriesDisclosed = dataCategoriesDisclosed;
            outboundRes.privacyClassification = privacyClassification;

            AIObservabilityMetric.create({
              correlationId: request.correlationId,
              organizationId: request.organizationId,
              userId: request.userId,
              sessionId: request.sessionId || "general",
              provider: backupProvider.name,
              model: backupName,
              modelAlias: request.modelAlias,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              estimatedCostUSD: usage.estimatedCostUSD,
              latencyMs: usage.latencyMs,
              status: "failover",
              privacyClassification,
              dataCategoriesDisclosed,
              purpose,
              retentionCategory
            }).catch(err => console.error("[AIGateway] Telemetry failover error:", err));

            return outboundRes;
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

        const outboundRes = await OutboundPipeline.process(
          fallbackRes.answer,
          request.correlationId,
          tokenMap,
          fallbackProvider.name,
          "simulation-fallback",
          usage,
          fallbackRes.citations
        );

        outboundRes.dataCategoriesDisclosed = dataCategoriesDisclosed;
        outboundRes.privacyClassification = privacyClassification;

        return outboundRes;
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
    samplePatientData?: Array<{ name?: string; mrn?: string; email?: string; phone?: string }>,
    extraContextInput?: { currentRoute?: string; activePatientId?: string; userRole?: string }
  ): Promise<AIResponse> {
    const startTime = Date.now();

    // 1. Run Inbound Pipeline
    const inboundContext = await InboundPipeline.process(request, samplePatientData, extraContextInput);
    const {
      anonymizedPrompt,
      tokenMap,
      providerName,
      modelEndpoint,
      compiledPrompt,
      privacyClassification,
      dataCategoriesDisclosed,
      purpose,
      retentionCategory
    } = inboundContext;

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

    const outboundRes = await OutboundPipeline.process(
      streamRes.answer,
      request.correlationId,
      tokenMap,
      provider.name,
      mapping.modelEndpoint,
      usage,
      streamRes.citations
    );

    outboundRes.dataCategoriesDisclosed = dataCategoriesDisclosed;
    outboundRes.privacyClassification = privacyClassification;

    AIObservabilityMetric.create({
      correlationId: request.correlationId,
      organizationId: request.organizationId,
      userId: request.userId,
      sessionId: "stream",
      provider: provider.name,
      model: mapping.modelEndpoint,
      modelAlias: request.modelAlias,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUSD: usage.estimatedCostUSD,
      latencyMs: usage.latencyMs,
      status: "success",
      privacyClassification,
      dataCategoriesDisclosed,
      purpose,
      retentionCategory
    }).catch(err => console.error("[AIGateway] Stream metric error:", err));

    return outboundRes;
  }

  /**
   * Enterprise SOAP note generation routed through the AI Gateway.
   */
  async generateSOAPNote(
    input: SOAPGenerationInput,
    context: { organizationId: string; userId: string; patientId?: string }
  ): Promise<SOAPNoteDraft> {
    const prompt = `Generate a SOAP note for: Chief Complaint: ${input.chiefComplaint}. History: ${input.history || "None"}. Exam: ${input.examinationFindings || "None"}.`;
    const res = await this.execute({
      correlationId: `corr_soap_${Date.now()}`,
      organizationId: context.organizationId,
      userId: context.userId,
      sessionId: `soap_${context.patientId || "patient"}`,
      requestId: `req_soap_${Date.now()}`,
      modelAlias: "CLINICAL_ACCURATE",
      prompt,
      systemDirective: "Generate structured clinical SOAP note.",
      dataClassification: "deidentified_clinical",
      purpose: "soap_note_drafting"
    }, undefined, { activePatientId: context.patientId });

    return {
      subjective: `Chief Complaint: ${input.chiefComplaint}. ${input.history || ""}`,
      objective: input.examinationFindings || (input.vitals ? `BP: ${input.vitals.bp}, HR: ${input.vitals.pulse}` : "Stable"),
      assessment: res.text || "Clinical assessment completed.",
      plan: "Follow-up as clinically indicated.",
      suggestedICD10: ["R69", "Z00.00"]
    };
  }

  /**
   * Enterprise Health Query Assistant routed through the AI Gateway.
   */
  async queryPatientHealthAssistant(
    input: HealthQueryInput,
    context: { organizationId: string; userId: string }
  ): Promise<HealthQueryResponse> {
    const res = await this.execute({
      correlationId: `corr_hqa_${Date.now()}`,
      organizationId: context.organizationId,
      userId: context.userId,
      sessionId: input.patientId || "general",
      requestId: `req_hqa_${Date.now()}`,
      modelAlias: "CLINICAL_FAST",
      prompt: input.query,
      systemDirective: input.systemPrompt || "Patient Health Record Assistant",
      chatHistory: input.chatHistory,
      dataClassification: "deidentified_clinical",
      purpose: "ehr_health_assistant"
    }, undefined, { activePatientId: input.patientId });

    return {
      answer: res.text,
      citations: res.citations || ["EHR Longitudinal History"],
      disclaimer: "ANANTA AI Health Assistant provides copilot guidance. Not a substitute for clinical judgment.",
      suggestedActions: res.suggestedActions,
      rawUsage: {
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens
      }
    };
  }
}

export const aiGateway = AIGateway.getInstance();

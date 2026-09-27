import type { AIRequest, AIResponse, AIUsage, AIProvider, SOAPGenerationInput, SOAPNoteDraft, HealthQueryInput, HealthQueryResponse } from "./AIProvider.ts";
import { providerRegistry } from "./ProviderRegistry.ts";
import { modelRegistry } from "./ModelRegistry.ts";
import { InboundPipeline, type InboundPipelineContext } from "./InboundPipeline.ts";
import { OutboundPipeline } from "./OutboundPipeline.ts";
import { AIServiceUnavailableError } from "./AIService.ts";
import { AIDataPrivacyError } from "../../utilities/phiAnonymizer.ts";
import { AIObservabilityMetric } from "../../models/AIObservabilityMetric.ts";

export class AIGateway {
  private static instance: AIGateway;
  private constructor() {}
  static getInstance(): AIGateway { return this.instance ||= new AIGateway(); }

  private providers(context: InboundPipelineContext): AIProvider[] {
    const preferred = providerRegistry.getProvider(context.providerName) || providerRegistry.getProvider();
    const candidates = [preferred, ...providerRegistry.listProviders().map(name => providerRegistry.getProvider(name))];
    const seen = new Set<string>();
    return candidates.filter((provider): provider is AIProvider => {
      if (!provider || seen.has(provider.name) || provider.name === "AIProviderUnavailable") return false;
      if (process.env.NODE_ENV === "production" && provider.name === "FallbackSimulationAI") return false;
      if (context.allowedProviders?.length && !context.allowedProviders.includes(provider.name)) return false;
      seen.add(provider.name); return true;
    }).sort((a, b) => Number(a.name === "FallbackSimulationAI") - Number(b.name === "FallbackSimulationAI"));
  }

  private payload(request: AIRequest, context: InboundPipelineContext, provider: AIProvider): HealthQueryInput {
    return {
      patientId: request.sessionId || "general", query: context.anonymizedPrompt,
      patientRecordSummary: context.anonymizedContext,
      chatHistory: request.chatHistory,
      systemPrompt: context.compiledPrompt?.systemPrompt || request.systemDirective,
      compiledPromptText: context.compiledPrompt?.userPrompt,
      modelEndpoint: provider.name === context.providerName ? context.modelEndpoint : provider.defaultModel,
    };
  }

  private async finish(request: AIRequest, context: InboundPipelineContext, provider: AIProvider, result: HealthQueryResponse, payload: HealthQueryInput, started: number, status: "success" | "failover"): Promise<AIResponse> {
    const model = result.modelEndpoint || payload.modelEndpoint || provider.defaultModel || "unknown";
    const mapping = modelRegistry.listModels().find(item => item.providerName === provider.name && item.modelEndpoint === model);
    const inputTokens = result.rawUsage?.inputTokens ?? Math.ceil(context.anonymizedPrompt.length / 4);
    const outputTokens = result.rawUsage?.outputTokens ?? Math.ceil(result.answer.length / 4);
    const usage: AIUsage = { inputTokens, outputTokens, estimatedCostUSD: ((inputTokens + outputTokens) / 1000) * (mapping?.costPer1kTokensUSD || 0), latencyMs: Math.max(1, Date.now() - started) };
    const response = await OutboundPipeline.process(result.answer, request.correlationId, context.tokenMap, provider.name, model, usage, result.citations);
    response.dataCategoriesDisclosed = context.dataCategoriesDisclosed;
    response.privacyClassification = context.privacyClassification;
    void AIObservabilityMetric.create({
      correlationId: request.correlationId, organizationId: request.organizationId || undefined,
      userId: request.userId || undefined, sessionId: request.sessionId || "general",
      provider: provider.name, model, modelAlias: request.modelAlias, ...usage, status,
      privacyClassification: context.privacyClassification, dataCategoriesDisclosed: context.dataCategoriesDisclosed,
      purpose: context.purpose, retentionCategory: context.retentionCategory,
    }).catch(error => console.error("[AIGateway] Telemetry record error:", error));
    return response;
  }

  async execute(request: AIRequest, samplePatientData?: Array<{ name?: string; mrn?: string; email?: string; phone?: string }>, extraContextInput?: { currentRoute?: string; activePatientId?: string; userRole?: string }): Promise<AIResponse> {
    const started = Date.now();
    let context: InboundPipelineContext;
    try { context = await InboundPipeline.process(request, samplePatientData, extraContextInput); }
    catch (error: any) {
      void AIObservabilityMetric.create({
        correlationId: request.correlationId || "blocked", organizationId: request.organizationId || undefined,
        userId: request.userId || undefined, sessionId: request.sessionId || "general", provider: "gateway_firewall", model: "none",
        modelAlias: request.modelAlias || "CLINICAL_FAST", inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0,
        latencyMs: Date.now() - started, status: error instanceof AIDataPrivacyError ? "blocked_privacy" : error instanceof AIServiceUnavailableError ? "blocked_killswitch" : "error",
        errorMessage: error.message, privacyClassification: request.dataClassification || "deidentified_clinical",
        purpose: request.purpose || "clinical_assistant", retentionCategory: request.retentionCategory || "operational_transient",
      }).catch(metricError => console.error("[AIGateway] Block metric failed:", metricError));
      throw error;
    }
    let lastError: unknown;
    const candidates = this.providers(context);
    for (let index = 0; index < candidates.length; index++) {
      const provider = candidates[index];
      const payload = this.payload(request, context, provider);
      let result: HealthQueryResponse;
      try { result = await provider.queryPatientHealthAssistant(payload); }
      catch (error) { lastError = error; continue; }
      // Outbound/privacy failures must not cause another provider request.
      return this.finish(request, context, provider, result, payload, started, index ? "failover" : "success");
    }
    throw new AIServiceUnavailableError(lastError instanceof Error ? lastError.message : "No permitted AI provider is available.");
  }

  async executeStream(request: AIRequest, onChunk: (token: string) => void, samplePatientData?: Array<{ name?: string; mrn?: string; email?: string; phone?: string }>, extraContextInput?: { currentRoute?: string; activePatientId?: string; userRole?: string }): Promise<AIResponse> {
    const started = Date.now();
    const context = await InboundPipeline.process(request, samplePatientData, extraContextInput);
    if (!context.enableStreaming) throw new AIServiceUnavailableError("AI streaming is disabled for this organization.");
    const provider = this.providers(context)[0];
    if (!provider) throw new AIServiceUnavailableError("No permitted AI provider is available.");
    const payload = this.payload(request, context, provider);
    const streamHandler = (token: string) => {
      let text = token;
      context.tokenMap.forEach((value, placeholder) => { text = text.replaceAll(placeholder, value); });
      onChunk(text);
    };
    // Do not fail over after emitting tokens: that would duplicate partial answers.
    const result = provider.streamHealthAssistant ? await provider.streamHealthAssistant(payload, streamHandler) : await provider.queryPatientHealthAssistant(payload);
    if (!provider.streamHealthAssistant) streamHandler(result.answer);
    return this.finish(request, context, provider, result, payload, started, "success");
  }

  async generateSOAPNote(
    input: SOAPGenerationInput,
    context: { organizationId: string; userId: string; patientId?: string }
  ): Promise<SOAPNoteDraft> {
    const vitals = input.vitals ? `Vitals: ${JSON.stringify(input.vitals)}` : "";
    const prompt = `Generate a SOAP note for: Chief Complaint: ${input.chiefComplaint}. History: ${input.history || "None"}. Exam: ${input.examinationFindings || "None"}. ${vitals}`;
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
      objective: [input.examinationFindings, vitals].filter(Boolean).join(". ") || "No objective findings supplied",
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
      prompt: input.query,
      systemDirective: input.systemPrompt || "Patient Health Record Assistant",
      chatHistory: input.chatHistory,
      dataClassification: "deidentified_clinical",
      purpose: "ehr_health_assistant"
    }, undefined, { activePatientId: input.patientId });

    return {
      answer: res.text,
      citations: res.citations || ["EHR Longitudinal History"],
      disclaimer: "Ekavyu AI Health Assistant provides copilot guidance. Not a substitute for clinical judgment.",
      suggestedActions: res.suggestedActions,
      rawUsage: {
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens
      }
    };
  }
}

export const aiGateway = AIGateway.getInstance();

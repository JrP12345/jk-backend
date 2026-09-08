import type { AIRequest } from "./AIProvider.ts";
import { PHIAnonymizer } from "../../utilities/phiAnonymizer.ts";
import { modelRegistry } from "./ModelRegistry.ts";
import { promptManager, type CompiledPrompt } from "./PromptManager.ts";
import { contextEngine, type Assembled6DContext } from "./ContextEngine.ts";
import { knowledgeRetrievalEngine, type RetrievalResult } from "./KnowledgeRetrievalEngine.ts";
import { agentOrchestrator } from "./AgentOrchestrator.ts";
import { aiAdminService } from "./AIAdminService.ts";

export interface InboundPipelineContext {
  request: AIRequest;
  anonymizedPrompt: string;
  anonymizedContext: string;
  compiledPrompt: CompiledPrompt;
  sixDContext: Assembled6DContext;
  knowledgeRetrieval: RetrievalResult;
  assignedAgentName: string;
  tokenMap: Map<string, string>;
  modelEndpoint: string;
  providerName: string;
}

export class InboundPipeline {
  /**
   * Executes the 7-stage inbound pipeline:
   * Validation ➔ Multi-Agent Orchestration ➔ 6D Context ➔ Knowledge Retrieval ➔ Model Mapping ➔ Prompt Assembly ➔ PHI Anonymization
   *
   * Feature flags (enablePHIAnonymization, enableMultiAgentRouting) are loaded from the
   * organization's AI config in MongoDB so they reflect admin changes in real-time.
   */
  static async process(
    request: AIRequest,
    samplePatientData?: Array<{ name?: string; mrn?: string; email?: string; phone?: string }>,
    extraContextInput?: { currentRoute?: string; activePatientId?: string; userRole?: string }
  ): Promise<InboundPipelineContext> {
    // 1. Validation
    if (!request.prompt || !request.prompt.trim()) {
      throw new Error("[InboundPipeline] Prompt is required for AI request execution");
    }
    if (!request.correlationId) {
      request.correlationId = `corr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    }

    // Load org feature flags from DB (real-time, respects admin UI changes)
    const orgConfig = await aiAdminService.getConfig(request.organizationId || "");
    const flags = orgConfig?.featureFlags;

    // 2. Multi-Agent Orchestrator Selection (respects enableMultiAgentRouting flag)
    let agentResult: { agentName: string; agentRole: string; systemDirective: string };
    if (flags?.enableMultiAgentRouting) {
      agentResult = await agentOrchestrator.routeAndExecute(
        request.prompt,
        extraContextInput?.currentRoute
      );
    } else {
      // Direct routing — skip orchestrator, use a generic clinical agent
      agentResult = {
        agentName: "GeneralClinicalAssistant",
        agentRole: "General Clinical AI",
        systemDirective: "You are a knowledgeable clinical assistant. Answer clearly and concisely."
      };
    }

    // 3. 6D Context Assembly
    const sixDContext = await contextEngine.build6DContext({
      currentRoute: extraContextInput?.currentRoute,
      activePatientId: extraContextInput?.activePatientId,
      userRole: extraContextInput?.userRole,
      organizationId: request.organizationId
    });

    // 4. Knowledge Layer Retrieval Engine
    const knowledgeRetrieval = knowledgeRetrievalEngine.search(request.prompt);

    // 5. Model Mapping
    const mapping = modelRegistry.getModelMapping(request.modelAlias || "CLINICAL_FAST");

    // 6. Assemble clinical context distinctly without fusing into the user query
    const combinedContext = [
      `Assigned AI Specialist: ${agentResult.agentName} (${agentResult.agentRole})\n${agentResult.systemDirective}`,
      sixDContext.fullContextSummary,
      request.systemDirective || "",
      knowledgeRetrieval.evidenceText ? `Verifiable Medical Evidence:\n${knowledgeRetrieval.evidenceText}` : ""
    ].filter(Boolean).join("\n\n");

    const compiledPrompt = await promptManager.getCompiledPrompt("CLINICAL_HEALTH_ASSISTANT", {
      context: combinedContext,
      query: request.prompt
    });

    // 7. PHI Anonymization Proxy: Anonymize user prompt and clinical context cleanly
    let anonymizedPrompt = request.prompt;
    let anonymizedContext = combinedContext;
    let tokenMap = new Map<string, string>();

    if (flags?.enablePHIAnonymization) {
      const phiList = [...(samplePatientData || [])];
      
      // If an active patient ID is provided, load exact PHI identifiers for anonymization
      if (extraContextInput?.activePatientId && extraContextInput.activePatientId.length === 24) {
        try {
          const { Patient } = await import("../../models/Patient.ts");
          const activeP = await Patient.findById(extraContextInput.activePatientId).populate("userId", "name email phone").lean();
          if (activeP) {
            const u = (activeP.userId as any) || {};
            phiList.unshift({
              name: u.name,
              mrn: (activeP as any).mrn || activeP._id.toString(),
              email: u.email,
              phone: u.phone
            });
          }
        } catch {}
      }

      // Anonymize the pure user query
      const promptAnonymized = PHIAnonymizer.anonymizeText(request.prompt, phiList);
      anonymizedPrompt = promptAnonymized.anonymizedText;
      promptAnonymized.tokenMap.forEach((val, key) => tokenMap.set(key, val));

      // Anonymize the clinical context
      const contextAnonymized = PHIAnonymizer.anonymizeText(combinedContext, phiList);
      anonymizedContext = contextAnonymized.anonymizedText;
      contextAnonymized.tokenMap.forEach((val, key) => tokenMap.set(key, val));

      // Anonymize compiled prompt user template
      const compiledAnonymized = PHIAnonymizer.anonymizeText(compiledPrompt.userPrompt, phiList);
      compiledPrompt.userPrompt = compiledAnonymized.anonymizedText;
      compiledAnonymized.tokenMap.forEach((val, key) => tokenMap.set(key, val));
    }

    return {
      request,
      anonymizedPrompt,
      anonymizedContext,
      compiledPrompt,
      sixDContext,
      knowledgeRetrieval,
      assignedAgentName: agentResult.agentName,
      tokenMap,
      modelEndpoint: mapping.modelEndpoint,
      providerName: mapping.providerName
    };
  }
}


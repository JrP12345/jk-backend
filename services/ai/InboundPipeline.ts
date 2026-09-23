import type { AIRequest } from "./AIProvider.ts";
import { PHIAnonymizer, AIDataPrivacyError } from "../../utilities/phiAnonymizer.ts";
import { modelRegistry } from "./ModelRegistry.ts";
import { promptManager, type CompiledPrompt } from "./PromptManager.ts";
import { contextEngine, type Assembled6DContext } from "./ContextEngine.ts";
import { knowledgeRetrievalEngine, type RetrievalResult } from "./KnowledgeRetrievalEngine.ts";
import { agentOrchestrator } from "./AgentOrchestrator.ts";
import { aiAdminService } from "./AIAdminService.ts";
import { AIServiceUnavailableError } from "./AIService.ts";

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
  privacyClassification: "nonclinical" | "deidentified_clinical" | "identifiable_clinical";
  dataCategoriesDisclosed: string[];
  purpose: string;
  retentionCategory: string;
}

export class InboundPipeline {
  /**
   * Executes the enterprise inbound AI privacy gateway pipeline:
   * 1. Kill switch validation (global & tenant)
   * 2. Data classification & policy enforcement (nonclinical, deidentified_clinical, identifiable_clinical)
   * 3. Multi-agent routing
   * 4. Minimum necessary context assembly
   * 5. Knowledge retrieval
   * 6. Model mapping
   * 7. Mandatory fail-closed PHI de-identification & detection
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

    // 2. Kill Switch Checks
    if (process.env.EXTERNAL_AI_KILL_SWITCH === "true" || process.env.EXTERNAL_AI_ENABLED === "false") {
      throw new AIServiceUnavailableError("External AI is globally disabled by platform kill switch.");
    }

    // Load org feature flags and policy from DB (real-time)
    const orgConfig = await aiAdminService.getConfig(request.organizationId || "");
    if ((orgConfig as any)?.externalAIKillSwitch === true) {
      throw new AIServiceUnavailableError("External AI is disabled for this organization by tenant policy.");
    }

    // 3. Data Classification Policy Enforcement
    const classification: "nonclinical" | "deidentified_clinical" | "identifiable_clinical" =
      request.dataClassification || (orgConfig as any)?.defaultDataClassification || "deidentified_clinical";

    const purpose = request.purpose || "clinical_decision_support";
    const retentionCategory = request.retentionCategory || "operational_transient";

    if (classification === "identifiable_clinical") {
      const allowed = Boolean((orgConfig as any)?.allowIdentifiableClinical && (orgConfig as any)?.providerBAA);
      if (!allowed) {
        throw new AIDataPrivacyError(
          "Identifiable clinical data processing prohibited: requires verified provider BAA/DPA and explicit tenant policy authorization."
        );
      }
    }

    // 4. Multi-Agent Orchestrator Selection
    const flags = orgConfig?.featureFlags;
    let agentResult: { agentName: string; agentRole: string; systemDirective: string };
    if (flags?.enableMultiAgentRouting) {
      agentResult = await agentOrchestrator.routeAndExecute(
        request.prompt,
        extraContextInput?.currentRoute
      );
    } else {
      agentResult = {
        agentName: "GeneralClinicalAssistant",
        agentRole: "General Clinical AI",
        systemDirective: "You are a knowledgeable clinical assistant. Answer clearly and concisely."
      };
    }

    // 5. Context Assembly (retrieve minimum necessary context)
    let sixDContext: Assembled6DContext;
    if (classification === "nonclinical") {
      // For nonclinical queries, do not load clinical/EHR records
      sixDContext = {
        currentRoute: extraContextInput?.currentRoute || "",
        activePatientId: undefined,
        userRole: extraContextInput?.userRole || "",
        fullContextSummary: "Nonclinical administrative context."
      };
    } else {
      sixDContext = await contextEngine.build6DContext({
        currentRoute: extraContextInput?.currentRoute,
        activePatientId: extraContextInput?.activePatientId,
        userRole: extraContextInput?.userRole,
        organizationId: request.organizationId
      });
    }

    // 6. Knowledge Layer Retrieval Engine
    const knowledgeRetrieval = knowledgeRetrievalEngine.search(request.prompt);

    // 7. Model Mapping
    const mapping = modelRegistry.getModelMapping(request.modelAlias || "CLINICAL_FAST");

    // 8. Assemble context
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

    // 9. Mandatory De-identification & Fail-Closed Guardrails
    let anonymizedPrompt = request.prompt;
    let anonymizedContext = combinedContext;
    let tokenMap = new Map<string, string>();
    const disclosedCategories = new Set<string>();

    if (classification === "nonclinical") {
      // Nonclinical requests must NOT contain unmasked patient PHI
      const scan = PHIAnonymizer.detectUnmaskedPHI(request.prompt);
      if (scan.hasUnmaskedPHI) {
        throw new AIDataPrivacyError(
          `Nonclinical request contains identifiable data (${scan.detectedCategories.join(", ")}). Aborting request.`
        );
      }
    } else if (classification === "deidentified_clinical") {
      // De-identification is MANDATORY for deidentified_clinical
      const phiList = [...(samplePatientData || [])];

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
        } catch {
          // If patient resolution fails in deidentified context, fail closed
          throw new AIDataPrivacyError("Failed to resolve active patient context for de-identification. Aborting request.");
        }
      }

      // Anonymize the pure user query
      const promptAnonymized = PHIAnonymizer.anonymizeText(request.prompt, phiList);
      anonymizedPrompt = promptAnonymized.anonymizedText;
      promptAnonymized.tokenMap.forEach((val, key) => tokenMap.set(key, val));
      promptAnonymized.disclosedCategories.forEach(cat => disclosedCategories.add(cat));

      // Anonymize the clinical context
      const contextAnonymized = PHIAnonymizer.anonymizeText(combinedContext, phiList);
      anonymizedContext = contextAnonymized.anonymizedText;
      contextAnonymized.tokenMap.forEach((val, key) => tokenMap.set(key, val));
      contextAnonymized.disclosedCategories.forEach(cat => disclosedCategories.add(cat));

      // Anonymize compiled prompt user template
      const compiledAnonymized = PHIAnonymizer.anonymizeText(compiledPrompt.userPrompt, phiList);
      compiledPrompt.userPrompt = compiledAnonymized.anonymizedText;
      compiledAnonymized.tokenMap.forEach((val, key) => tokenMap.set(key, val));

      // Post-deidentification validation (fail-closed check)
      const postScan = PHIAnonymizer.detectUnmaskedPHI(anonymizedPrompt);
      if (postScan.hasUnmaskedPHI) {
        throw new AIDataPrivacyError(
          `De-identification failed to scrub sensitive identifiers: ${postScan.detectedCategories.join(", ")}. Aborting to prevent data leak.`
        );
      }
    } else {
      // identifiable_clinical (permitted only with active BAA)
      disclosedCategories.add("IDENTIFIABLE_CLINICAL_RECORD");
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
      providerName: mapping.providerName,
      privacyClassification: classification,
      dataCategoriesDisclosed: Array.from(disclosedCategories),
      purpose,
      retentionCategory
    };
  }
}

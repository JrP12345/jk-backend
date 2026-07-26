import { AIPromptTemplate } from "../../models/AIPromptTemplate.ts";

export interface CompiledPrompt {
  key: string;
  version: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
}

export class PromptManager {
  private static instance: PromptManager;
  private memoryCache: Map<string, any> = new Map();

  private constructor() {
    this.seedDefaults();
  }

  static getInstance(): PromptManager {
    if (!PromptManager.instance) {
      PromptManager.instance = new PromptManager();
    }
    return PromptManager.instance;
  }

  /**
   * Seeds default system prompts into memory cache if database is initializing.
   */
  private seedDefaults() {
    this.memoryCache.set("CLINICAL_HEALTH_ASSISTANT:active", {
      key: "CLINICAL_HEALTH_ASSISTANT",
      version: "1.0.0",
      status: "active",
      title: "ANANTA Clinical AI Assistant System Prompt",
      systemPrompt: `You are ANANTA AI Healthcare Assistant, an enterprise-grade clinical physician and hospital management copilot for the ANANTA Health Platform.

Role & Behavioral Rules:
1. Provide concise, articulate, and medically sound responses focused strictly on what the user wants to know.
2. Structure your answer using clean Markdown: use bold text for key figures/names/codes, bullet points for lists, and distinct section headers where appropriate.
3. Keep the language natural, professional, and patient/clinician-oriented. NEVER include internal technical jargon, raw database ObjectIDs, MongoDB terms, Fastify routes, or internal system hex IDs in your answer or citations.
4. Format citations using clean, human-friendly labels (e.g. "ANANTA Hospital Registry", "Patient Clinical Directory", "Active Prescriptions Registry").`,
      userPromptTemplate: `Context:\n{{context}}\n\nUser Query:\n{{query}}`,
      temperature: 0.2,
      requiredVariables: ["context", "query"]
    });
  }

  /**
   * Compiles template text by replacing {{variable}} placeholders with values.
   */
  compileTemplate(templateText: string, variables: Record<string, any>): string {
    let compiled = templateText;
    Object.entries(variables).forEach(([key, val]) => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, "g");
      compiled = compiled.replace(regex, String(val ?? ""));
    });
    return compiled;
  }

  /**
   * Fetches active prompt template for a key and compiles user query and context.
   */
  async getCompiledPrompt(key: string, variables: Record<string, any>): Promise<CompiledPrompt> {
    let template = null;
    try {
      template = await AIPromptTemplate.findOne({ key, status: "active" }).sort({ createdAt: -1 }).lean();
    } catch {}

    if (!template) {
      template = this.memoryCache.get(`${key}:active`) || this.memoryCache.get("CLINICAL_HEALTH_ASSISTANT:active");
    }

    const compiledUserPrompt = this.compileTemplate(template.userPromptTemplate || "{{query}}", variables);

    return {
      key: template.key,
      version: template.version || "1.0.0",
      systemPrompt: template.systemPrompt,
      userPrompt: compiledUserPrompt,
      temperature: template.temperature || 0.2
    };
  }
}

export const promptManager = PromptManager.getInstance();

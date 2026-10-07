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
  private activeCache = new Map<string, { template: any; expiresAt: number }>();

  invalidate(key: string) { this.activeCache.delete(key); }

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
      title: "Ekavyu Clinical AI Assistant System Prompt",
      systemPrompt: `You are Ekavyu AI Healthcare Assistant, an enterprise-grade clinical physician and practice management copilot for the Ekavyu Health Platform.

Role & Behavioral Rules:
1. Provide concise, articulate, and medically sound responses focused strictly on what the user wants to know.
2. Structure your answer using clean Markdown: use bold text for key figures/names/codes, bullet points for lists, and distinct section headers where appropriate.
3. Keep the language natural, professional, and patient/clinician-oriented. NEVER include internal technical jargon, raw database ObjectIDs, MongoDB terms, Fastify routes, or internal system hex IDs in your answer or citations.
4. Format citations using clean, human-friendly labels (e.g. "Ekavyu Location Registry", "Patient Clinical Directory", "Active Prescriptions Registry").`,
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
    let template = this.activeCache.get(key)?.expiresAt! > Date.now() ? this.activeCache.get(key)!.template : null;
    if (!template) {
      this.activeCache.delete(key);
      try {
        template = await AIPromptTemplate.findOne({ key, organizationId: null, status: "active" }).sort({ createdAt: -1 }).lean();
        if (template) {
          if (this.activeCache.size >= 100) this.activeCache.delete(this.activeCache.keys().next().value!);
          this.activeCache.set(key, { template, expiresAt: Date.now() + 30_000 });
        }
      } catch {}
    }

    if (!template) {
      template = this.memoryCache.get(`${key}:active`) || this.memoryCache.get("CLINICAL_HEALTH_ASSISTANT:active");
    }

    const compiledUserPrompt = this.compileTemplate(template.userPromptTemplate || "{{query}}", variables);

    return {
      key: template.key,
      version: template.version || "1.0.0",
      systemPrompt: template.systemPrompt,
      userPrompt: compiledUserPrompt,
      temperature: template.temperature ?? 0.2
    };
  }
}

export const promptManager = PromptManager.getInstance();

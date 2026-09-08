import type { AIProvider, SOAPGenerationInput, SOAPNoteDraft, HealthQueryInput, HealthQueryResponse, AISuggestedAction } from "./AIProvider.ts";
import { providerRegistry } from "./ProviderRegistry.ts";

export class AIServiceUnavailableError extends Error {
  public statusCode = 503;
  constructor(message: string = "Clinical AI service is temporarily unavailable") {
    super(message);
    this.name = "AIServiceUnavailableError";
  }
}

class FallbackAIProvider implements AIProvider {
  name = "FallbackSimulationAI";

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async generateSOAPNote(input: SOAPGenerationInput): Promise<SOAPNoteDraft> {
    const vitalsStr = input.vitals
      ? `BP: ${input.vitals.bp || "120/80"}, HR: ${input.vitals.pulse || 72} bpm, Temp: ${input.vitals.temp || 98.6}°F, SpO2: ${input.vitals.spO2 || 98}%`
      : "Vitals within normal limits";

    return {
      subjective: `Patient presents with chief complaint of ${input.chiefComplaint}. ${input.history || "No prior surgical or medical history reported."}`,
      objective: `Physical Exam: ${input.examinationFindings || "Alert, oriented x3, in no acute distress."} ${vitalsStr}`,
      assessment: `Clinical Impression: Symptomatic ${input.chiefComplaint}. Differential diagnoses evaluated against active symptoms.`,
      plan: `1. Symptomatic relief and supportive therapy.\n2. Follow up in 3-5 days if symptoms persist.\n3. Return immediately if red-flag symptoms occur.`,
      suggestedICD10: ["R50.9", "Z00.00"],
    };
  }

  async queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse> {
    const actions: AISuggestedAction[] = [
      { type: "VIEW_PATIENT", label: "📋 View Patient Directory", targetUrl: "/dashboard/patients" },
      { type: "ANALYTICS", label: "📊 View Clinic Dashboard", targetUrl: "/dashboard" }
    ];

    return {
      answer: `Based on the patient health record summary:\n\n${input.patientRecordSummary}\n\nQuery Analysis: "${input.query}" — The record shows active health history. Consult the attending physician for definitive clinical management.`,
      citations: ["Longitudinal PHR Record", "Patient Encounter Summaries"],
      disclaimer: "ANANTA AI Health Assistant provides administrative & clinical copilot guidance.",
      suggestedActions: actions
    };
  }

  async streamHealthAssistant(input: HealthQueryInput, onToken: (chunk: string) => void): Promise<HealthQueryResponse> {
    const fullRes = await this.queryPatientHealthAssistant(input);
    const words = fullRes.answer.split(" ");
    for (let i = 0; i < words.length; i++) {
      onToken((i === 0 ? "" : " ") + words[i]);
    }
    return fullRes;
  }
}

class UnavailableAIProvider implements AIProvider {
  name = "AIProviderUnavailable";

  async isHealthy(): Promise<boolean> {
    return false;
  }

  async generateSOAPNote(): Promise<SOAPNoteDraft> {
    throw new Error("No configured AI provider is available");
  }

  async queryPatientHealthAssistant(): Promise<HealthQueryResponse> {
    throw new Error("No configured AI provider is available");
  }
}

import { validateSOAPNoteDraft, validateHealthQueryResponse } from "./aiValidation.ts";

class GeminiAIProvider implements AIProvider {
  name = "GoogleGeminiAI";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async isHealthy(): Promise<boolean> {
    return !!this.apiKey && this.apiKey.length > 10;
  }

  private async callGemini(prompt: string, schemaConfig?: any): Promise<any> {
    const primaryModel = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const modelsToTry = [primaryModel, "gemini-2.0-flash", "gemini-1.5-pro"];
    let lastError: Error | null = null;

    for (let i = 0; i < modelsToTry.length; i++) {
      const model = modelsToTry[i];
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseMimeType: "application/json",
              ...(schemaConfig ? { responseSchema: schemaConfig } : {})
            }
          }),
          signal: AbortSignal.timeout(15000)
        });

        if (res.ok) {
          const data = await res.json();
          const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const cleaned = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
            return {
              data: JSON.parse(cleaned),
              usage: {
                inputTokens: data?.usageMetadata?.promptTokenCount,
                outputTokens: data?.usageMetadata?.candidatesTokenCount
              }
            };
          }
          throw new Error("Empty candidate content returned from Gemini API");
        }

        const errText = await res.text();
        // Do not retry on client-side authentication or invalid payload errors (400, 401, 403)
        if (res.status === 400 || res.status === 401 || res.status === 403) {
          throw new Error(`Gemini API authorization/client error ${res.status}: ${errText}`);
        }

        lastError = new Error(`Gemini (${model}) ${res.status}: ${errText}`);
        // If rate limited (429) or transient 503, pause briefly before trying next model
        if (res.status === 429 || res.status >= 500) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (err: any) {
        lastError = err;
        // Fast-fail if this is an explicit auth/client error
        if (err.message && (err.message.includes("401") || err.message.includes("403"))) {
          break;
        }
      }
    }

    throw lastError || new Error("Gemini AI generation failed");
  }

  async generateSOAPNote(input: SOAPGenerationInput): Promise<SOAPNoteDraft> {
    const prompt = `You are an expert attending physician AI specializing in evidence-based clinical documentation.
Generate a comprehensive, structured SOAP note JSON conforming to international clinical standards (ICD-10-CM coding).

Clinical Encounter Inputs:
- Chief Complaint: ${input.chiefComplaint}
- Vitals: ${JSON.stringify(input.vitals || {})}
- Examination Findings: ${input.examinationFindings || "Alert, oriented x3, cardiovascular/respiratory within normal limits"}
- Patient History: ${input.history || "No significant surgical or medical history reported"}

Return ONLY a JSON object matching this schema:
{
  "subjective": "Detailed History of Present Illness (HPI), chief complaint narrative, symptom onset, and review of systems",
  "objective": "Systematic physical examination findings integrated with objective vital signs",
  "assessment": "Primary clinical diagnosis with clinical justification, differential diagnoses, and severity stratification",
  "plan": "Numbered actionable management plan: 1. Diagnostics/Labs 2. Pharmacotherapy & Dosage 3. Patient Education 4. Follow-up timeframe",
  "suggestedICD10": ["PRIMARY_ICD10_CODE", "SECONDARY_ICD10_CODE"]
}`;

    const schemaConfig = {
      type: "OBJECT",
      properties: {
        subjective: { type: "STRING" },
        objective: { type: "STRING" },
        assessment: { type: "STRING" },
        plan: { type: "STRING" },
        suggestedICD10: {
          type: "ARRAY",
          items: { type: "STRING" }
        }
      },
      required: ["subjective", "objective", "assessment", "plan"]
    };

    const raw = await this.callGemini(prompt, schemaConfig);
    return validateSOAPNoteDraft(raw.data || raw);
  }

  async queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse> {
    const historyText = input.chatHistory && input.chatHistory.length > 0
      ? `\n\nRecent Conversation History:\n` + input.chatHistory.map(t => `${t.sender.toUpperCase()}: ${t.text}`).join("\n")
      : "";

    const systemDirective = input.systemPrompt
      ? `${input.systemPrompt}\n\nStrict JSON formatting rules apply.`
      : `You are ANANT AI Healthcare Assistant, an enterprise-grade clinical physician and hospital management copilot for the ANANT Health Platform.

Role & Behavioral Rules:
1. Provide concise, articulate, and medically sound responses focused strictly on what the user wants to know.
2. Structure your answer using clean Markdown: use bold text for key figures/names/codes, bullet points for lists, and distinct section headers where appropriate.
3. Keep the language natural, professional, and patient/clinician-oriented. NEVER include internal technical jargon, raw database ObjectIDs, MongoDB terms, Fastify routes, or internal system hex IDs in your answer or citations.
4. If the user asks about patient counts, rosters, or specific clinical problems, list them cleanly with human-readable MRNs and conditions.
5. Format citations using clean, human-friendly labels (e.g. "ANANT Hospital Registry", "Patient Clinical Directory", "Active Prescriptions Registry").
6. Recommend relevant interactive UI actions ("suggestedActions") to help the user navigate the platform. Choose relevant URLs from the following application routes:
   - Patient Directory: "/dashboard/patients"
   - Patient EHR & Timeline: "/dashboard/patients/[patient_id]" (if a specific patient ID is known)
   - Appointments & Scheduling: "/dashboard/appointments"
   - Inpatient Admissions & Bed Occupancy: "/dashboard/admissions"
   - Hospital Analytics & Financials: "/dashboard/analytics"
   - Prescriptions & Pharmacy: "/dashboard/prescriptions"`;

    const contentBody = input.compiledPromptText || `Context:\n${input.patientRecordSummary}${historyText}\n\nUser Query:\n${input.query}`;

    const prompt = `${systemDirective}

${contentBody}

Return ONLY a JSON object matching this schema:
{
  "answer": "Clean, highly professional Markdown response providing clear answers without technical clutter",
  "citations": ["Clean Human-Readable Source 1", "Clean Human-Readable Source 2"],
  "disclaimer": "ANANTA AI Health Assistant provides grounded administrative & clinical copilot guidance.",
  "suggestedActions": [
    {
      "type": "VIEW_PATIENT | SCHEDULE_APPOINTMENT | PRESCRIBE_MEDICATION | VIEW_TIMELINE | ANALYTICS",
      "label": "Button Label with Emoji",
      "targetUrl": "Exact route path from the list above"
    }
  ]
}`;

    const schemaConfig = {
      type: "OBJECT",
      properties: {
        answer: { type: "STRING" },
        citations: { type: "ARRAY", items: { type: "STRING" } },
        disclaimer: { type: "STRING" },
        suggestedActions: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              type: { type: "STRING" },
              label: { type: "STRING" },
              targetUrl: { type: "STRING" }
            },
            required: ["type", "label"]
          }
        }
      },
      required: ["answer"]
    };

    const raw = await this.callGemini(prompt, schemaConfig);
    const validated = validateHealthQueryResponse(raw.data || raw);
    return {
      ...validated,
      rawUsage: raw.usage
    };
  }

  async streamHealthAssistant(input: HealthQueryInput, onToken: (chunk: string) => void): Promise<HealthQueryResponse> {
    const historyText = input.chatHistory && input.chatHistory.length > 0
      ? `\n\nRecent Conversation History:\n` + input.chatHistory.map(t => `${t.sender.toUpperCase()}: ${t.text}`).join("\n")
      : "";

    const systemDirective = input.systemPrompt || "You are ANANT AI Healthcare Assistant, an enterprise-grade clinical physician and hospital management copilot for the ANANT Health Platform.";
    const contentBody = input.compiledPromptText || `Context:\n${input.patientRecordSummary}${historyText}\n\nUser Query:\n${input.query}`;

    const prompt = `${systemDirective}\n\n${contentBody}\n\nRespond in concise, articulate, and clear professional Markdown.`;

    const model = process.env.GEMINI_MODEL || "gemini-1.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini Stream Error ${res.status}: ${errText}`);
    }

    if (!res.body) throw new Error("Empty response stream from Gemini");

    let fullAnswer = "";
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const rawChunk of res.body as any) {
      buffer += decoder.decode(rawChunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const token = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || "";
            if (token) {
              fullAnswer += token;
              onToken(token);
            }
          } catch {}
        }
      }
    }

    return {
      answer: fullAnswer || "Response generated.",
      citations: ["ANANT Clinical Registry"],
      disclaimer: "ANANTA AI Health Assistant provides grounded administrative & clinical copilot guidance.",
      suggestedActions: []
    };
  }
}

class OpenAICompatibleProvider implements AIProvider {
  name: string;
  private apiKey: string;
  private baseURL: string;
  private model: string;

  constructor(name: string, apiKey: string, baseURL: string, model: string) {
    this.name = name;
    this.apiKey = apiKey;
    this.baseURL = baseURL;
    this.model = model;
  }

  async isHealthy(): Promise<boolean> {
    return !!this.apiKey && this.apiKey.length > 5;
  }

  async generateSOAPNote(input: SOAPGenerationInput): Promise<SOAPNoteDraft> {
    const prompt = `You are a clinical physician AI. Create a structured SOAP note in JSON format for:
Chief Complaint: ${input.chiefComplaint}
Vitals: ${JSON.stringify(input.vitals || {})}
Exam: ${input.examinationFindings || "Normal"}
History: ${input.history || "None"}

JSON Keys: subjective, objective, assessment, plan, suggestedICD10 (array of codes).`;

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: "You respond strictly in valid JSON format conforming to SOAP clinical standards." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} returned empty content`);
    const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const raw = JSON.parse(cleaned);
    return validateSOAPNoteDraft(raw);
  }

  async queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse> {
    const historyText = input.chatHistory && input.chatHistory.length > 0
      ? `\n\nRecent Conversation History:\n` + input.chatHistory.map(t => `${t.sender.toUpperCase()}: ${t.text}`).join("\n")
      : "";

    const systemContent = input.systemPrompt || "You are ANANTA AI Healthcare Assistant. You respond strictly in valid JSON format conforming to the requested schema.";
    const userPrompt = input.compiledPromptText || `Context:\n${input.patientRecordSummary}${historyText}\n\nUser Query:\n${input.query}\n\nReturn JSON matching schema: { "answer": "text", "citations": ["src"], "disclaimer": "text", "suggestedActions": [] }`;

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${this.name} API error ${res.status}: ${errText}`);
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error(`${this.name} returned empty content`);
    const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    const raw = JSON.parse(cleaned);
    const validated = validateHealthQueryResponse(raw);
    return {
      ...validated,
      rawUsage: {
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens
      }
    };
  }

  async streamHealthAssistant(input: HealthQueryInput, onToken: (chunk: string) => void): Promise<HealthQueryResponse> {
    const historyText = input.chatHistory && input.chatHistory.length > 0
      ? `\n\nRecent Conversation History:\n` + input.chatHistory.map(t => `${t.sender.toUpperCase()}: ${t.text}`).join("\n")
      : "";

    const systemContent = input.systemPrompt || "You are an enterprise clinical AI assistant. Respond in clear Markdown.";
    const userPrompt = input.compiledPromptText || `Context:\n${input.patientRecordSummary}${historyText}\n\nUser Query:\n${input.query}\n\nRespond in concise, articulate, and clear professional Markdown.`;

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: userPrompt }
        ],
        stream: true
      }),
      signal: AbortSignal.timeout(30000)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${this.name} stream error ${res.status}: ${errText}`);
    }

    if (!res.body) throw new Error(`${this.name} empty response body`);

    let fullAnswer = "";
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const rawChunk of res.body as any) {
      buffer += decoder.decode(rawChunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const jsonStr = line.slice(6).trim();
          if (!jsonStr || jsonStr === "[DONE]") continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const token = parsed?.choices?.[0]?.delta?.content || "";
            if (token) {
              fullAnswer += token;
              onToken(token);
            }
          } catch {}
        }
      }
    }

    return {
      answer: fullAnswer || "Response generated.",
      citations: ["ANANT Clinical Registry"],
      disclaimer: "ANANTA AI Health Assistant provides grounded administrative & clinical copilot guidance.",
      suggestedActions: []
    };
  }
}

export class AIService {
  private fallbackProvider = new FallbackAIProvider();
  private primaryProvider: AIProvider = this.fallbackProvider;

  constructor() {
    providerRegistry.registerProvider(this.fallbackProvider);

    let hasRealProvider = false;

    if (process.env.GEMINI_API_KEY) {
      console.log("[AIService] Initializing Google Gemini AI Provider");
      const gemini = new GeminiAIProvider(process.env.GEMINI_API_KEY);
      providerRegistry.registerProvider(gemini);
      if (!hasRealProvider) {
        this.primaryProvider = gemini;
        providerRegistry.setPrimaryProvider(gemini.name);
        hasRealProvider = true;
      }
    }

    if (process.env.OPENAI_API_KEY) {
      console.log("[AIService] Initializing OpenAI GPT-4o Provider");
      const openai = new OpenAICompatibleProvider("OpenAI", process.env.OPENAI_API_KEY, "https://api.openai.com/v1", process.env.OPENAI_MODEL || "gpt-4o-mini");
      providerRegistry.registerProvider(openai);
      if (!hasRealProvider) {
        this.primaryProvider = openai;
        providerRegistry.setPrimaryProvider(openai.name);
        hasRealProvider = true;
      }
    }

    if (process.env.GROQ_API_KEY) {
      console.log("[AIService] Initializing Groq Llama 3.3 Provider");
      const groq = new OpenAICompatibleProvider("GroqAI", process.env.GROQ_API_KEY, "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile");
      providerRegistry.registerProvider(groq);
      if (!hasRealProvider) {
        this.primaryProvider = groq;
        providerRegistry.setPrimaryProvider(groq.name);
        hasRealProvider = true;
      }
    }

    if (!hasRealProvider) {
      if (process.env.NODE_ENV === "test") {
        console.log("[AIService] No API Key detected in test environment; using test-only fallback provider");
        this.primaryProvider = this.fallbackProvider;
        providerRegistry.setPrimaryProvider(this.fallbackProvider.name);
      } else if (process.env.NODE_ENV === "production") {
        console.error("[AIService] No AI provider credentials configured in production; clinical AI provider set to unavailable");
        this.primaryProvider = new UnavailableAIProvider();
        providerRegistry.setPrimaryProvider(this.primaryProvider.name);
      } else {
        console.warn("[AIService] No AI provider credentials configured; non-production environment using local fallback copilot");
        this.primaryProvider = this.fallbackProvider;
        providerRegistry.setPrimaryProvider(this.primaryProvider.name);
      }
    }
  }

  public setProvider(provider: AIProvider) {
    this.primaryProvider = provider;
  }

  public getProviderName(): string {
    return this.primaryProvider.name;
  }

  public async generateSOAPNote(input: SOAPGenerationInput): Promise<SOAPNoteDraft> {
    try {
      return await this.primaryProvider.generateSOAPNote(input);
    } catch (err: any) {
      // Attempt real failover to other registered production providers first
      const allProviders = providerRegistry.listProviders().filter(
        name => name !== this.primaryProvider.name && name !== "FallbackSimulationAI" && name !== "AIProviderUnavailable"
      );
      for (const backupName of allProviders) {
        const backup = providerRegistry.getProvider(backupName);
        if (backup) {
          try {
            console.log(`[AIService] Failing over generateSOAPNote to ${backupName}`);
            return await backup.generateSOAPNote(input);
          } catch (backupErr: any) {
            console.warn(`[AIService] Backup provider ${backupName} failed:`, backupErr.message);
          }
        }
      }

      if (process.env.NODE_ENV === "production") {
        throw new AIServiceUnavailableError(`AI documentation service temporarily unavailable: ${err?.message || "Generation error"}`);
      }
      console.warn(`[AIService] ${this.primaryProvider.name} failed (${err.message}); falling back to local clinical copilot engine.`);
      return await this.fallbackProvider.generateSOAPNote(input);
    }
  }

  public async queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse> {
    try {
      return await this.primaryProvider.queryPatientHealthAssistant(input);
    } catch (err: any) {
      // Attempt real failover to other registered production providers first
      const allProviders = providerRegistry.listProviders().filter(
        name => name !== this.primaryProvider.name && name !== "FallbackSimulationAI" && name !== "AIProviderUnavailable"
      );
      for (const backupName of allProviders) {
        const backup = providerRegistry.getProvider(backupName);
        if (backup) {
          try {
            console.log(`[AIService] Failing over queryPatientHealthAssistant to ${backupName}`);
            return await backup.queryPatientHealthAssistant(input);
          } catch (backupErr: any) {
            console.warn(`[AIService] Backup provider ${backupName} failed:`, backupErr.message);
          }
        }
      }

      if (process.env.NODE_ENV === "production") {
        throw new AIServiceUnavailableError(`AI health assistant query temporarily unavailable: ${err?.message || "Gateway error"}`);
      }
      console.warn(`[AIService] ${this.primaryProvider.name} failed (${err.message}); falling back to local clinical copilot engine.`);
      return await this.fallbackProvider.queryPatientHealthAssistant(input);
    }
  }
}

export const aiService = new AIService();

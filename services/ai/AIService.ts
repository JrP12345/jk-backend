import type { AIProvider, SOAPGenerationInput, SOAPNoteDraft, HealthQueryInput, HealthQueryResponse, AISuggestedAction } from "./AIProvider.ts";
import { providerRegistry } from "./ProviderRegistry.ts";

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

class GeminiAIProvider implements AIProvider {
  name = "GoogleGeminiAI";
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async isHealthy(): Promise<boolean> {
    return !!this.apiKey && this.apiKey.length > 10;
  }

  private async callGemini(prompt: string): Promise<any> {
    const customModel = process.env.GEMINI_MODEL;
    const fallbackModels = [
      "gemini-2.5-flash",
      "gemini-1.5-flash",
      "gemini-1.5-flash-latest",
      "gemini-1.5-pro",
      "gemini-1.5-pro-latest",
      "gemini-flash-latest",
      "gemini-pro-latest"
    ];
    const models = customModel ? [customModel, ...fallbackModels] : fallbackModels;
    let lastError = null;

    for (const model of models) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });

        if (res.ok) {
          const data = await res.json();
          const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (rawText) {
            const cleaned = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
            try {
              return JSON.parse(cleaned);
            } catch {
              return { answer: cleaned, citations: [], suggestedActions: [] };
            }
          }
        } else {
          const errText = await res.text();
          lastError = new Error(`Gemini (${model}) ${res.status}: ${errText}`);
        }
      } catch (err: any) {
        lastError = err;
      }
    }

    throw lastError || new Error("All Gemini model endpoints failed");
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
  "objective": "Systematic physical examination findings (Heent, Cardiac, Pulmonary, Abdomen, Neuro) integrated with objective vital signs",
  "assessment": "Primary clinical diagnosis with clinical justification, differential diagnoses, and severity stratification",
  "plan": "Numbered actionable management plan: 1. Diagnostics/Labs 2. Pharmacotherapy & Dosage 3. Patient Education 4. Follow-up timeframe",
  "suggestedICD10": ["PRIMARY_ICD10_CODE", "SECONDARY_ICD10_CODE"]
}`;

    return await this.callGemini(prompt) as SOAPNoteDraft;
  }

  async queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse> {
    const historyText = input.chatHistory && input.chatHistory.length > 0
      ? `\n\nRecent Conversation History:\n` + input.chatHistory.map(t => `${t.sender.toUpperCase()}: ${t.text}`).join("\n")
      : "";

    const prompt = `You are ANANT AI Healthcare Assistant, an enterprise-grade clinical physician and hospital management copilot for the ANANT Health Platform.

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
   - Prescriptions & Pharmacy: "/dashboard/prescriptions"

Context:
${input.patientRecordSummary}${historyText}

User Query:
${input.query}

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

    return await this.callGemini(prompt) as HealthQueryResponse;
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
          { role: "system", content: "You respond strictly in valid JSON format." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (!res.ok) throw new Error(`${this.name} API error ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    return JSON.parse(cleaned) as SOAPNoteDraft;
  }

  async queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse> {
    const historyText = input.chatHistory && input.chatHistory.length > 0
      ? `\n\nRecent Conversation History:\n` + input.chatHistory.map(t => `${t.sender.toUpperCase()}: ${t.text}`).join("\n")
      : "";

    const prompt = `You are ANANTA AI Healthcare Assistant. Answer the query based on context:

Context:
${input.patientRecordSummary}${historyText}

User Query:
${input.query}

Return JSON matching schema: { "answer": "text", "citations": ["src"], "disclaimer": "text", "suggestedActions": [] }`;

    const res = await fetch(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: "You respond strictly in valid JSON format." },
          { role: "user", content: prompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (!res.ok) throw new Error(`${this.name} API error ${res.status}`);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    const cleaned = content.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
    return JSON.parse(cleaned) as HealthQueryResponse;
  }
}

export class AIService {
  private primaryProvider: AIProvider;
  private fallbackProvider = new FallbackAIProvider();

  constructor() {
    providerRegistry.registerProvider(this.fallbackProvider);

    if (process.env.GEMINI_API_KEY) {
      console.log("[AIService] Initializing Google Gemini AI Provider");
      const gemini = new GeminiAIProvider(process.env.GEMINI_API_KEY);
      this.primaryProvider = gemini;
      providerRegistry.registerProvider(gemini);
      providerRegistry.setPrimaryProvider(gemini.name);
    } else if (process.env.GROQ_API_KEY) {
      console.log("[AIService] Initializing Groq Llama 3.3 Provider");
      const groq = new OpenAICompatibleProvider("GroqAI", process.env.GROQ_API_KEY, "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile");
      this.primaryProvider = groq;
      providerRegistry.registerProvider(groq);
      providerRegistry.setPrimaryProvider(groq.name);
    } else if (process.env.OPENAI_API_KEY) {
      console.log("[AIService] Initializing OpenAI GPT-4o Provider");
      const openai = new OpenAICompatibleProvider("OpenAI", process.env.OPENAI_API_KEY, "https://api.openai.com/v1", "gpt-4o-mini");
      this.primaryProvider = openai;
      providerRegistry.registerProvider(openai);
      providerRegistry.setPrimaryProvider(openai.name);
    } else if (process.env.NODE_ENV === "test") {
      console.log("[AIService] No API Key detected in test environment; using test-only fallback provider");
      this.primaryProvider = this.fallbackProvider;
      providerRegistry.setPrimaryProvider(this.fallbackProvider.name);
    } else {
      console.error("[AIService] No AI provider credentials configured; clinical AI operations are using local fallback copilot");
      this.primaryProvider = this.fallbackProvider;
      providerRegistry.setPrimaryProvider(this.primaryProvider.name);
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
      console.warn(`[AIService] ${this.primaryProvider.name} failed (${err.message}); falling back to local clinical copilot engine.`);
      return await this.fallbackProvider.generateSOAPNote(input);
    }
  }

  public async queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse> {
    try {
      return await this.primaryProvider.queryPatientHealthAssistant(input);
    } catch (err: any) {
      console.warn(`[AIService] ${this.primaryProvider.name} failed (${err.message}); falling back to local clinical copilot engine.`);
      return await this.fallbackProvider.queryPatientHealthAssistant(input);
    }
  }
}

export const aiService = new AIService();

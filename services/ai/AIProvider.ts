export interface SOAPGenerationInput {
  chiefComplaint: string;
  vitals?: {
    bp?: string;
    pulse?: number;
    temp?: number;
    respRate?: number;
    spO2?: number;
  };
  examinationFindings?: string;
  history?: string;
}

export interface SOAPNoteDraft {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  suggestedICD10?: string[];
}

export interface ChatTurn {
  sender: "user" | "ai";
  text: string;
}

export interface HealthQueryInput {
  patientId: string;
  query: string;
  patientRecordSummary: string;
  chatHistory?: ChatTurn[];
  systemPrompt?: string;
  compiledPromptText?: string;
}

export interface AISuggestedAction {
  type: "VIEW_PATIENT" | "SCHEDULE_APPOINTMENT" | "PRESCRIBE_MEDICATION" | "VIEW_TIMELINE" | "ANALYTICS";
  label: string;
  targetUrl?: string;
  payload?: Record<string, any>;
}

export interface HealthQueryResponse {
  answer: string;
  citations: string[];
  disclaimer: string;
  suggestedActions?: AISuggestedAction[];
  rawUsage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

// ─── ENTERPRISE AI CONTRACTS ──────────────────────────────────────────

export type AIModelAlias = "CLINICAL_FAST" | "CLINICAL_ACCURATE" | "CLINICAL_REASONING";

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUSD: number;
  latencyMs: number;
}

export interface AIRequest {
  correlationId: string;
  organizationId: string;
  sessionId: string;
  requestId: string;
  userId: string;
  modelAlias: AIModelAlias;
  prompt: string;
  temperature?: number;
  maxTokens?: number;
  systemDirective?: string;
  chatHistory?: ChatTurn[];
}

export interface AIResponse {
  correlationId: string;
  text: string;
  citations: string[];
  suggestedActions?: AISuggestedAction[];
  usage: AIUsage;
  provider: string;
  model: string;
}

export interface AIStreamChunk {
  correlationId: string;
  chunkIndex: number;
  text: string;
  isComplete: boolean;
  usage?: AIUsage;
}

export interface AIProvider {
  name: string;
  isHealthy(): Promise<boolean>;
  generateSOAPNote(input: SOAPGenerationInput): Promise<SOAPNoteDraft>;
  queryPatientHealthAssistant(input: HealthQueryInput): Promise<HealthQueryResponse>;
  streamHealthAssistant?(input: HealthQueryInput, onToken: (chunk: string) => void): Promise<HealthQueryResponse>;
  executeRequest?(request: AIRequest): Promise<AIResponse>;
}

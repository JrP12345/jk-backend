import type { SOAPNoteDraft, HealthQueryResponse, AISuggestedAction } from "./AIProvider.ts";

export class AISchemaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AISchemaValidationError";
  }
}

/**
 * Validates and sanitizes a SOAP note draft returned by an AI provider.
 */
export function validateSOAPNoteDraft(raw: any): SOAPNoteDraft {
  if (!raw || typeof raw !== "object") {
    throw new AISchemaValidationError("SOAP note response is not a valid JSON object");
  }

  const subjective = typeof raw.subjective === "string" ? raw.subjective.trim() : "";
  const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
  const assessment = typeof raw.assessment === "string" ? raw.assessment.trim() : "";
  const plan = typeof raw.plan === "string" ? raw.plan.trim() : "";

  if (!subjective && !objective && !assessment && !plan) {
    throw new AISchemaValidationError("SOAP note draft is missing core clinical fields (subjective, objective, assessment, plan)");
  }

  const suggestedICD10: string[] = Array.isArray(raw.suggestedICD10)
    ? raw.suggestedICD10.filter((c: any) => typeof c === "string" && c.trim().length > 0).map((c: string) => c.trim())
    : [];

  return {
    subjective: subjective || "No subjective notes reported.",
    objective: objective || "No objective findings recorded.",
    assessment: assessment || "Assessment pending clinical review.",
    plan: plan || "Management plan pending attending physician review.",
    suggestedICD10
  };
}

/**
 * Validates and sanitizes a Health Query response returned by an AI provider.
 */
export function validateHealthQueryResponse(raw: any): HealthQueryResponse {
  if (!raw || typeof raw !== "object") {
    throw new AISchemaValidationError("Health query response is not a valid JSON object");
  }

  const answer = typeof raw.answer === "string" ? raw.answer.trim() : "";
  if (!answer) {
    throw new AISchemaValidationError("Health query response answer is empty");
  }

  const citations: string[] = Array.isArray(raw.citations)
    ? raw.citations.filter((c: any) => typeof c === "string" && c.trim().length > 0).map((c: string) => c.trim())
    : ["ANANT Clinical Registry"];

  const disclaimer = typeof raw.disclaimer === "string" && raw.disclaimer.trim()
    ? raw.disclaimer.trim()
    : "ANANTA AI Health Assistant provides grounded administrative & clinical copilot guidance.";

  const suggestedActions: AISuggestedAction[] = [];
  if (Array.isArray(raw.suggestedActions)) {
    for (const act of raw.suggestedActions) {
      if (act && typeof act === "object" && typeof act.label === "string") {
        suggestedActions.push({
          type: act.type || "VIEW_PATIENT",
          label: act.label.trim(),
          targetUrl: typeof act.targetUrl === "string" ? act.targetUrl.trim() : undefined,
          payload: typeof act.payload === "object" ? act.payload : undefined
        });
      }
    }
  }

  return {
    answer,
    citations,
    disclaimer,
    suggestedActions
  };
}

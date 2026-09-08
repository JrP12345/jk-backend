import { describe, it, expect } from "vitest";
import { validateSOAPNoteDraft, validateHealthQueryResponse, AISchemaValidationError } from "../services/ai/aiValidation.ts";
import { AIService, AIServiceUnavailableError } from "../services/ai/AIService.ts";

describe("Batch 1: AI Provider Security & Schema Validation Tests", () => {
  it("should validate and sanitize valid SOAP note draft structure", () => {
    const validDraft = {
      subjective: "Patient reports intermittent throbbing headaches",
      objective: "BP: 120/80, Neurological exam non-focal",
      assessment: "Tension headache vs mild migraine",
      plan: "1. Hydration 2. Paracetamol PRN",
      suggestedICD10: ["G43.909", "R51"]
    };

    const validated = validateSOAPNoteDraft(validDraft);
    expect(validated.subjective).toBe(validDraft.subjective);
    expect(validated.objective).toBe(validDraft.objective);
    expect(validated.assessment).toBe(validDraft.assessment);
    expect(validated.plan).toBe(validDraft.plan);
    expect(validated.suggestedICD10).toEqual(["G43.909", "R51"]);
  });

  it("should reject completely empty or non-object SOAP note response", () => {
    expect(() => validateSOAPNoteDraft(null)).toThrow(AISchemaValidationError);
    expect(() => validateSOAPNoteDraft("not an object")).toThrow(AISchemaValidationError);
    expect(() => validateSOAPNoteDraft({})).toThrow(AISchemaValidationError);
  });

  it("should validate and sanitize health query response with suggested actions", () => {
    const validResponse = {
      answer: "The patient has documented hypertension and no reported drug allergies.",
      citations: ["Patient Profile", "Prescription Records"],
      disclaimer: "ANANTA Clinical Guidance",
      suggestedActions: [
        { type: "VIEW_PATIENT", label: "View Chart", targetUrl: "/dashboard/patients/123" }
      ]
    };

    const validated = validateHealthQueryResponse(validResponse);
    expect(validated.answer).toContain("hypertension");
    expect(validated.citations).toHaveLength(2);
    expect(validated.suggestedActions).toHaveLength(1);
    expect(validated.suggestedActions![0].targetUrl).toBe("/dashboard/patients/123");
  });

  it("should throw AIServiceUnavailableError in production when primary provider fails", async () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const service = new AIService();
      // Service in production with no configured key sets primary to UnavailableAIProvider
      await expect(service.generateSOAPNote({ chiefComplaint: "Chest pain" })).rejects.toThrow(AIServiceUnavailableError);
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

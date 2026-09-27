import { describe, it, expect, vi } from "vitest";
import { validateSOAPNoteDraft, validateHealthQueryResponse, AISchemaValidationError } from "../services/ai/aiValidation.ts";
import { AIServiceUnavailableError } from "../services/ai/AIService.ts";
import { aiGateway } from "../services/ai/AIGateway.ts";
import { InboundPipeline } from "../services/ai/InboundPipeline.ts";
import { providerRegistry } from "../services/ai/ProviderRegistry.ts";

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

  it("refuses simulated AI execution in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const query = vi.fn();
    vi.spyOn(InboundPipeline, "process").mockResolvedValue({ providerName: "FallbackSimulationAI", allowedProviders: [] } as any);
    vi.spyOn(providerRegistry, "listProviders").mockReturnValue(["FallbackSimulationAI"]);
    vi.spyOn(providerRegistry, "getProvider").mockReturnValue({ name: "FallbackSimulationAI", queryPatientHealthAssistant: query } as any);
    try {
      await expect(aiGateway.execute({ correlationId: "prod-guard", organizationId: "", userId: "", sessionId: "test", requestId: "test", prompt: "Explain clinic scheduling", dataClassification: "nonclinical" })).rejects.toThrow(AIServiceUnavailableError);
      expect(query).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});

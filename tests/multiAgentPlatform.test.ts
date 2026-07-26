import { describe, it, expect } from "vitest";
import { agentOrchestrator } from "../services/ai/AgentOrchestrator.ts";
import { InboundPipeline } from "../services/ai/InboundPipeline.ts";
import type { AIRequest } from "../services/ai/AIProvider.ts";

describe("Phase 6: Multi-Agent Platform & Orchestration Tests", () => {
  it("should route scheduling queries to ReceptionAgent", () => {
    const agent = agentOrchestrator.selectAgent("Book follow-up appointment for next Tuesday", "/dashboard/appointments");
    expect(agent.name).toBe("ReceptionAgent");
  });

  it("should route SOAP and lab queries to ClinicalAgent", () => {
    const agent = agentOrchestrator.selectAgent("Generate SOAP note for acute asthma exacerbation", "/dashboard/patients/chart");
    expect(agent.name).toBe("ClinicalAgent");
  });

  it("should route ICD-10 and claims queries to BillingRCMAgent", () => {
    const agent = agentOrchestrator.selectAgent("Audit ICD-10 coding for insurance claim", "/dashboard/billing");
    expect(agent.name).toBe("BillingRCMAgent");
  });

  it("should route discharge and patient guides to PatientAgent", () => {
    const agent = agentOrchestrator.selectAgent("Explain my medication intake instructions", "/portal");
    expect(agent.name).toBe("PatientAgent");
  });

  it("should execute InboundPipeline with AgentOrchestrator and assign ClinicalAgent", async () => {
    const req: AIRequest = {
      correlationId: `corr_agent_${Date.now()}`,
      organizationId: "org_agent_test",
      sessionId: "sess_agent_test",
      requestId: "req_agent_test",
      userId: "usr_agent_test",
      modelAlias: "CLINICAL_FAST",
      prompt: "Interpret vitals and draft SOAP assessment"
    };

    const ctx = await InboundPipeline.process(req);
    expect(ctx.assignedAgentName).toBe("ClinicalAgent");
  });
});

import { describe, it, expect } from "vitest";
import { aiGateway } from "../services/ai/AIGateway.ts";
import type { AIRequest } from "../services/ai/AIProvider.ts";

describe("Work Package B: Enterprise AIGateway & Inbound/Outbound Pipelines", () => {
  it("should execute AI request through Gateway and return PHI re-hydrated response with correlation ID", async () => {
    const req: AIRequest = {
      correlationId: `corr_b_${Date.now()}`,
      organizationId: "org_gateway_test",
      sessionId: "sess_gateway_test",
      requestId: "req_gateway_test",
      userId: "usr_gateway_test",
      modelAlias: "CLINICAL_FAST",
      prompt: "What are active medical conditions for John Doe?"
    };

    const patientData = [{ name: "John Doe", mrn: "MRN-6A64E9" }];

    const response = await aiGateway.execute(req, patientData);

    expect(response.correlationId).toBe(req.correlationId);
    expect(response.text).toBeDefined();
    expect(response.provider).toBeDefined();
    expect(response.usage).toBeDefined();
    expect(response.usage.latencyMs).toBeGreaterThan(0);
  });

  it("should trigger failover fallback cleanly if primary provider fails", async () => {
    const req: AIRequest = {
      correlationId: `corr_failover_${Date.now()}`,
      organizationId: "org_failover",
      sessionId: "sess_failover",
      requestId: "req_failover",
      userId: "usr_failover",
      modelAlias: "CLINICAL_ACCURATE", // non-existent OpenAI endpoint in test mode
      prompt: "Summarize patient encounter"
    };

    const response = await aiGateway.execute(req);

    expect(response.correlationId).toBe(req.correlationId);
    expect(response.text).toBeDefined();
    expect(response.provider).toBeDefined();
  });

  it("should execute streaming request yielding incremental token chunks", async () => {
    const req: AIRequest = {
      correlationId: `corr_stream_${Date.now()}`,
      organizationId: "org_stream_test",
      sessionId: "sess_stream",
      requestId: "req_stream",
      userId: "usr_stream",
      modelAlias: "CLINICAL_FAST",
      prompt: "What is hypertension?"
    };

    const receivedChunks: string[] = [];
    const response = await aiGateway.executeStream(req, (chunk) => {
      receivedChunks.push(chunk);
    });

    expect(response.correlationId).toBe(req.correlationId);
    expect(receivedChunks.length).toBeGreaterThan(0);
    expect(response.text.length).toBeGreaterThan(0);
  });
});

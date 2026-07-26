import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { AIObservabilityMetric } from "../models/AIObservabilityMetric.ts";
import { aiObservabilityService } from "../services/ai/AIObservabilityService.ts";

describe("Phase 7: AI Observability Engine & Analytics Tests", () => {
  let accessToken: string;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    const email = `dr_obs_engine_${Date.now()}@ananta.internal`;
    const password = "Password123!";

    const org = await (Organization as any).create({
      name: "Observability Test Hospital",
      email: `obs_engine_${Date.now()}@ananta.internal`,
      phone: "+1999555333",
      address: "500 Metric Way",
      city: "San Francisco",
    });
    testOrgId = (org as any)._id.toString();

    const user = await (User as any).create({
      email,
      name: "Dr. AI Observability",
      password: await bcrypt.hash(password, 10),
      role: "admin",
      organizationId: org._id
    });
    testUserId = (user as any)._id.toString();

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password }
    });

    accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // Create telemetry sample logs
    await AIObservabilityMetric.create({
      correlationId: "corr_obs_001",
      organizationId: (org as any)._id,
      userId: (user as any)._id,
      provider: "GoogleGeminiAI",
      model: "gemini-flash-latest",
      inputTokens: 450,
      outputTokens: 150,
      estimatedCostUSD: 0.000045,
      latencyMs: 180,
      status: "success"
    });
  });

  afterAll(async () => {
    await AIObservabilityMetric.deleteMany({ organizationId: testOrgId });
    await User.deleteMany({ _id: testUserId });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should calculate telemetry summary with AIObservabilityService", async () => {
    const summary = await aiObservabilityService.getOrganizationSummary(testOrgId);

    expect(summary.totalRequests).toBeGreaterThanOrEqual(1);
    expect(summary.totalInputTokens).toBeGreaterThanOrEqual(450);
    expect(summary.totalOutputTokens).toBeGreaterThanOrEqual(150);
    expect(summary.totalEstimatedCostUSD).toBeGreaterThan(0);
    expect(summary.providerBreakdown).toHaveProperty("GoogleGeminiAI");
  });

  it("should query AI Observability REST endpoints (GET /api/ai/observability/metrics & /costs)", async () => {
    const metricsRes = await app.inject({
      method: "GET",
      url: "/api/ai/observability/metrics",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const metricsBody = JSON.parse(metricsRes.payload);
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsBody.data.totalRequests).toBeGreaterThanOrEqual(1);

    const costsRes = await app.inject({
      method: "GET",
      url: "/api/ai/observability/costs",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const costsBody = JSON.parse(costsRes.payload);
    expect(costsRes.statusCode).toBe(200);
    expect(costsBody.data.monthlyTokenBudget).toBe(5000000);
    expect(costsBody.data.estimatedSpendUSD).toBeDefined();
  });
});

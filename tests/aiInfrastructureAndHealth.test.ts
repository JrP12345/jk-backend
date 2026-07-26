import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { AIObservabilityMetric } from "../models/AIObservabilityMetric.ts";

describe("Work Package C: Enterprise AI Gateway Infrastructure & Operations Health Tests", () => {
  let accessToken: string;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    const email = `dr_gateway_infra_${Date.now()}@ananta.internal`;
    const password = "Password123!";

    const org = await (Organization as any).create({
      name: "Gateway Test Hospital",
      email: `gateway_test_${Date.now()}@ananta.internal`,
      phone: "+1999888777",
      address: "100 Innovation Way",
      city: "San Francisco",
    });
    testOrgId = (org as any)._id.toString();

    const user = await (User as any).create({
      email,
      name: "Dr. Gateway Infra",
      password: await bcrypt.hash(password, 10),
      role: "doctor",
      organizationId: org._id
    });
    testUserId = (user as any)._id.toString();

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password }
    });

    accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";
  });

  afterAll(async () => {
    await AIObservabilityMetric.deleteMany({ userId: testUserId });
    await User.deleteMany({ _id: testUserId });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should probe AI System Health status (GET /api/ai/health)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ai/health"
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBeDefined();
    expect(body.data.providers).toBeDefined();
  });

  it("should query AI Gateway endpoint and verify correlation ID (POST /api/ai/gateway/query)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ai/gateway/query",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        query: "What is hospital bed occupancy?",
        modelAlias: "CLINICAL_FAST"
      }
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.correlationId).toBeDefined();
    expect(body.data.text).toBeDefined();
  });

  it("should stream AI response using Server-Sent Events (POST /api/ai/gateway/stream)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ai/gateway/stream",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        query: "Explain active prescriptions",
        modelAlias: "CLINICAL_FAST"
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.payload).toContain("data: ");
    expect(res.payload).toContain("isComplete");
  });
});

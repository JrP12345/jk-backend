import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { AIToolExecutionLog } from "../models/AIToolExecutionLog.ts";
import { aiToolRouter } from "../services/ai/AIToolRouter.ts";

describe("Phase 5: Agentic Tool Execution & Clinician Co-Signature Approval Tests", () => {
  let accessToken: string;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    const email = `dr_tool_exec_${Date.now()}@ananta.internal`;
    const password = "Password123!";

    const org = await (Organization as any).create({
      name: "Tool Exec Test Hospital",
      email: `tool_exec_${Date.now()}@ananta.internal`,
      phone: "+1999666444",
      address: "400 Tool Way",
      city: "San Francisco",
      state: "CA"
    });
    testOrgId = (org as any)._id.toString();

    const user = await (User as any).create({
      email,
      name: "Dr. Agentic Tool Exec",
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
    await AIToolExecutionLog.deleteMany({ requestedByUserId: testUserId });
    await User.deleteMany({ _id: testUserId });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should detect tool intent from natural language prompt", () => {
    const intent = aiToolRouter.detectIntent("Can you schedule an appointment for Maria Garcia next Tuesday at 10 AM?");

    expect(intent.detected).toBe(true);
    expect(intent.tool?.name).toBe("createAppointmentTool");
    expect(intent.confidence).toBeGreaterThan(0.9);
  });

  it("should request tool execution, log pending approval in MongoDB, and approve with clinician co-signature", async () => {
    // 1. Request Tool Execution
    const reqRes = await app.inject({
      method: "POST",
      url: "/api/ai/tools/request-execution",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        toolName: "createAppointmentTool",
        inputPayload: { patientName: "Maria Garcia", date: "2026-08-01" },
        sessionId: "sess_tool_test"
      }
    });

    const reqBody = JSON.parse(reqRes.payload);
    expect(reqRes.statusCode).toBe(201);
    expect(reqBody.data.status).toBe("pending_approval");
    const logId = reqBody.data._id;

    // 2. Clinician Approve & Co-Sign Execution
    const approveRes = await app.inject({
      method: "PUT",
      url: `/api/ai/tools/${logId}/approve`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const approveBody = JSON.parse(approveRes.payload);
    expect(approveRes.statusCode).toBe(200);
    expect(approveBody.data.status).toBe("approved_and_executed");
    expect(approveBody.data.executionResult).toBeDefined();
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { AIPromptTemplate } from "../models/AIPromptTemplate.ts";
import { promptManager } from "../services/ai/PromptManager.ts";

describe("Phase 2: Prompt Governance System Tests", () => {
  let accessToken: string;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    const email = `dr_prompt_gov_${Date.now()}@ananta.internal`;
    const password = "Password123!";

    const org = await (Organization as any).create({
      name: "Prompt Gov Test Hospital",
      email: `prompt_gov_${Date.now()}@ananta.internal`,
      phone: "+1999888666",
      address: "200 Governance Way",
      city: "San Francisco",
      state: "CA"
    });
    testOrgId = (org as any)._id.toString();

    const user = await (User as any).create({
      email,
      name: "Dr. Prompt Governance",
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
  });

  afterAll(async () => {
    await AIPromptTemplate.deleteMany({ key: "TEST_CLINICAL_PROMPT" });
    await User.deleteMany({ _id: testUserId });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should compile template variables with PromptManager", () => {
    const template = "Hello Doctor {{doctorName}}, patient {{patientName}} has vitals: {{vitals}}.";
    const compiled = promptManager.compileTemplate(template, {
      doctorName: "Smith",
      patientName: "John Doe",
      vitals: "120/80 BP"
    });

    expect(compiled).toBe("Hello Doctor Smith, patient John Doe has vitals: 120/80 BP.");
  });

  it("should create draft prompt version, approve to active, and fetch via PromptManager", async () => {
    // 1. Create Draft
    const createRes = await app.inject({
      method: "POST",
      url: "/api/ai/prompts",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        key: "TEST_CLINICAL_PROMPT",
        version: "1.0.0",
        title: "Test Clinical SOAP Prompt",
        systemPrompt: "You are a specialized clinical note compiler.",
        userPromptTemplate: "Chief Complaint: {{chiefComplaint}}",
        temperature: 0.1,
        requiredVariables: ["chiefComplaint"]
      }
    });

    const createBody = JSON.parse(createRes.payload);
    expect(createRes.statusCode).toBe(201);
    expect(createBody.data.status).toBe("draft");
    const templateId = createBody.data._id;

    // 2. Approve Draft to Active
    const approveRes = await app.inject({
      method: "PUT",
      url: `/api/ai/prompts/${templateId}/approve`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const approveBody = JSON.parse(approveRes.payload);
    expect(approveRes.statusCode).toBe(200);
    expect(approveBody.data.status).toBe("active");

    // 3. Query via PromptManager
    const compiled = await promptManager.getCompiledPrompt("TEST_CLINICAL_PROMPT", {
      chiefComplaint: "Acute Chest Pain"
    });

    expect(compiled.key).toBe("TEST_CLINICAL_PROMPT");
    expect(compiled.version).toBe("1.0.0");
    expect(compiled.userPrompt).toBe("Chief Complaint: Acute Chest Pain");
  });

  it("should test prompt compilation sandbox endpoint (POST /api/ai/prompts/test)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ai/prompts/test",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        templateText: "Evaluate {{medication}} dosage for {{age}}yo patient",
        variables: { medication: "Amoxicillin 500mg", age: 45 }
      }
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(200);
    expect(body.data.compiled).toBe("Evaluate Amoxicillin 500mg dosage for 45yo patient");
  });
});

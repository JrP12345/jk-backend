import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { AIChatSession } from "../models/AIChatSession.ts";

describe("Milestone 5: Enterprise DB-Backed AI Chat Persistence Tests", () => {
  let accessToken: string;
  let testUserId: string;
  let testOrgId: string;
  let testSessionId: string;

  beforeAll(async () => {
    // 1. Create Test Organization & User
    const email = `dr_enterprise_chat_${Date.now()}@ananta.internal`;
    const password = "Password123!";

    const org = await (Organization as any).create({
      name: "Enterprise Chat Test Hospital",
      email: `chat_test_hospital_${Date.now()}@ananta.internal`,
      phone: "+1999888777",
      address: "100 Innovation Way",
      city: "San Francisco",
    });
    testOrgId = (org as any)._id.toString();

    const user = await (User as any).create({
      email,
      name: "Dr. Enterprise Chat",
      password: await bcrypt.hash(password, 10),
      role: "doctor",
      organizationId: org._id
    });
    testUserId = (user as any)._id.toString();
    await OrgMember.create({ userId: user._id, organizationId: org._id, role: "doctor" });

    // Login via API to get auth token
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password }
    });

    accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";
  });

  afterAll(async () => {
    await AIChatSession.deleteMany({ userId: testUserId });
    await OrgMember.deleteMany({ userId: testUserId, organizationId: testOrgId });
    await User.deleteMany({ _id: testUserId });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should create a new MongoDB chat session (POST /api/ai/chat/sessions)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/ai/chat/sessions",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { initialTitle: "Test Clinical Session" }
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.id).toBeDefined();
    expect(body.data.title).toBe("Test Clinical Session");
    expect(body.data.messages.length).toBe(1); // Welcome message

    testSessionId = body.data.id;
  });

  it("should list active chat sessions for the user (GET /api/ai/chat/sessions)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ai/chat/sessions",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].id).toBe(testSessionId);
  });

  it("should send a chat message, trigger RAG, and persist User + AI turns into MongoDB (POST /api/ai/chat/sessions/:id/messages)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/ai/chat/sessions/${testSessionId}/messages`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { query: "How many patients do I have in system?" }
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.sessionId).toBe(testSessionId);
    expect(body.data.userMessage.text).toBe("How many patients do I have in system?");
    expect(body.data.aiMessage.text).toBeDefined();
    expect(body.data.allMessages.length).toBe(3); // Initial welcome + user + AI

    // Verify directly in MongoDB
    const sessionInDb = await AIChatSession.findById(testSessionId);
    expect(sessionInDb).not.toBeNull();
    expect(sessionInDb?.messages.length).toBe(3);
  });

  it("should retrieve full session trajectory (GET /api/ai/chat/sessions/:id)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/ai/chat/sessions/${testSessionId}`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe(testSessionId);
    expect(body.data.messages.length).toBe(3);
  });

  it("should archive a chat session (DELETE /api/ai/chat/sessions/:id)", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/ai/chat/sessions/${testSessionId}`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const body = JSON.parse(res.payload);
    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);

    const sessionInDb = await AIChatSession.findById(testSessionId);
    expect(sessionInDb?.status).toBe("archived");
  });
});

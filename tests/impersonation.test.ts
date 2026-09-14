import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";

describe("Root Superadmin Impersonation Engine Tests", () => {
  let rootAccessToken: string;
  let rootUserId: string;
  let rootEmail: string;

  let testOrgId: string;
  let doctorUserId: string;
  let doctorEmail: string;

  beforeAll(async () => {
    // 1. Create Root User
    rootEmail = `root_impersonate_${Date.now()}@platform.internal`;
    const password = "Password123!";
    const rootUser = await (User as any).create({
      email: rootEmail,
      name: "Root Test Platform Admin",
      password: await bcrypt.hash(password, 10),
      role: "root",
    });
    rootUserId = (rootUser as any)._id.toString();

    // 2. Create Tenant Org & Doctor User
    const org = await (Organization as any).create({
      name: "Impersonation Test Clinic",
      email: `clinic_${Date.now()}@platform.internal`,
      phone: "+919876543210",
      city: "Ahmedabad",
      plan: "pro",
    });
    testOrgId = (org as any)._id.toString();

    doctorEmail = `dr_smith_${Date.now()}@platform.internal`;
    const doctorUser = await (User as any).create({
      email: doctorEmail,
      name: "Dr. Smith Test",
      password: await bcrypt.hash(password, 10),
      role: "doctor",
      organization_id: org._id,
    });
    doctorUserId = (doctorUser as any)._id.toString();

    await OrgMember.create({
      userId: doctorUser._id,
      organizationId: org._id,
      role: "doctor",
    });

    // 3. Login as Root to get root cookies
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: rootEmail, password },
    });

    rootAccessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";
  });

  afterAll(async () => {
    await OrgMember.deleteMany({ organizationId: testOrgId });
    await User.deleteMany({ _id: { $in: [rootUserId, doctorUserId] } });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should list organization members via GET /api/onboarding/organizations/:id/members", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/onboarding/organizations/${testOrgId}/members`,
      cookies: { access_token: rootAccessToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.members).toBeDefined();
    expect(body.data.members.length).toBeGreaterThanOrEqual(1);

    const doc = body.data.members.find((m: any) => m.id === doctorUserId);
    expect(doc).toBeDefined();
    expect(doc.name).toBe("Dr. Smith Test");
    expect(doc.role).toBe("doctor");
  });

  it("should fetch global users via GET /api/admin/users", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/admin/users?role=doctor&q=Smith`,
      cookies: { access_token: rootAccessToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.users).toBeDefined();
    const found = body.data.users.find((u: any) => u.id === doctorUserId);
    expect(found).toBeDefined();
    expect(found.role).toBe("doctor");
    expect(found.organizationName).toBe("Impersonation Test Clinic");
  });

  it("should fetch platform hierarchy via GET /api/admin/hierarchy", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/admin/hierarchy",
      cookies: { access_token: rootAccessToken },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.organizations).toBeDefined();
    expect(body.data.summary).toBeDefined();
    const targetOrg = body.data.organizations.find((o: any) => o.id === testOrgId);
    expect(targetOrg).toBeDefined();
    expect(targetOrg.name).toBe("Impersonation Test Clinic");
  });

  it("should allow root superadmin to impersonate a doctor without password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/impersonate",
      cookies: { access_token: rootAccessToken },
      payload: { userId: doctorUserId },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe(doctorUserId);
    expect(body.data.user.role).toBe("doctor");
    expect(body.data.user.impersonatedBy).toBeDefined();
    expect(body.data.user.impersonatedBy.id).toBe(rootUserId);
    expect(body.data.user.impersonatedBy.originalRole).toBe("root");

    const impersonatedToken = (res.cookies as any[]).find((c: any) => c.name === "access_token")?.value || "";
    expect(impersonatedToken).toBeTruthy();

    // Verify GET /api/auth/me reflects impersonated doctor identity with impersonatedBy flag
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `access_token=${impersonatedToken}` },
    });

    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.body);
    expect(meBody.data.user.role).toBe("doctor");
    expect(meBody.data.user.name).toBe("Dr. Smith Test");
    expect(meBody.data.user.impersonatedBy.originalRole).toBe("root");
  });

  it("should stop impersonation and return back to Root Superadmin", async () => {
    // 1. Impersonate doctor first
    const impRes = await app.inject({
      method: "POST",
      url: "/api/auth/impersonate",
      cookies: { access_token: rootAccessToken },
      payload: { userId: doctorUserId },
    });
    const impToken = (impRes.cookies as any[]).find((c: any) => c.name === "access_token")?.value || "";

    // 2. Stop impersonation using the impersonated token
    const stopRes = await app.inject({
      method: "POST",
      url: "/api/auth/stop-impersonation",
      headers: { cookie: `access_token=${impToken}` },
    });

    expect(stopRes.statusCode).toBe(200);
    const stopBody = JSON.parse(stopRes.body);
    expect(stopBody.success).toBe(true);
    expect(stopBody.data.user.role).toBe("root");
    expect(stopBody.data.user.id).toBe(rootUserId);
    expect(stopBody.data.user.impersonatedBy).toBeFalsy();

    const restoredToken = (stopRes.cookies as any[]).find((c: any) => c.name === "access_token")?.value || "";
    expect(restoredToken).toBeTruthy();

    // 3. Confirm GET /api/auth/me with restored token shows Root Superadmin
    const meRes = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `access_token=${restoredToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const meBody = JSON.parse(meRes.body);
    expect(meBody.data.user.role).toBe("root");
    expect(meBody.data.user.email).toBe(rootEmail);
  });

  it("should reject non-root users from attempting impersonation", async () => {
    // Login as doctor
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: doctorEmail, password: "Password123!" },
    });
    const doctorToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // Doctor attempts to impersonate
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/impersonate",
      cookies: { access_token: doctorToken },
      payload: { userId: rootUserId },
    });

    expect(res.statusCode).toBe(403);
  });
});

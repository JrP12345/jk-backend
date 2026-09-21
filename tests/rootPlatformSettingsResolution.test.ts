import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { generateAccessToken } from "../utilities/helpers.ts";

describe("Root Super-Admin Platform Settings Fallback & Context Resolution", () => {
  let rootCookie: string;
  let nonOrgUserCookie: string;
  let primaryOrg: any;
  let secondaryOrg: any;

  beforeAll(async () => {
    // Clear and seed test organizations
    await Organization.deleteMany({ name: { $in: ["Primary Root Org", "Secondary Root Org"] } });
    await User.deleteMany({ email: { $in: ["superadmin-root@test.local", "unlinked-user@test.local"] } });

    primaryOrg = await Organization.create({
      name: "Primary Root Org",
      city: "Valsad",
      isActive: true,
      address: "100 Medical Enclave",
    });

    secondaryOrg = await Organization.create({
      name: "Secondary Root Org",
      city: "Surat",
      isActive: true,
      address: "200 Ring Road",
    });

    const rootUser = await User.create({
      name: "Platform Root Superadmin",
      email: "superadmin-root@test.local",
      password: "Password123!",
      role: "root",
      isActive: true,
    });

    const unlinkedUser = await User.create({
      name: "Unlinked Admin",
      email: "unlinked-user@test.local",
      password: "Password123!",
      role: "admin",
      isActive: true,
    });

    rootCookie = `access_token=${generateAccessToken({
      id: rootUser._id.toString(),
      email: rootUser.email!,
      role: "root",
    })}`;

    nonOrgUserCookie = `access_token=${generateAccessToken({
      id: unlinkedUser._id.toString(),
      email: unlinkedUser.email!,
      role: "admin",
    })}`;
  });

  it("1. Root without organizationId fallback resolves primary active organization on /api/onboarding/organization/me", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/onboarding/organization/me",
      headers: { cookie: rootCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.name).toBe(primaryOrg.name);
  });

  it("2. Root with explicit organizationId resolves target organization on /api/onboarding/organization/me", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/onboarding/organization/me?organizationId=${secondaryOrg._id.toString()}`,
      headers: { cookie: rootCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("Secondary Root Org");
  });

  it("3. Root without organizationId resolves SMTP configuration on /api/onboarding/organization/me/smtp", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/onboarding/organization/me/smtp",
      headers: { cookie: rootCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  it("4. Root without organizationId resolves WhatsApp settings without 403 on /api/organization/whatsapp", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/organization/whatsapp",
      headers: { cookie: rootCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  it("5. Root without organizationId resolves AI Admin config on /api/ai/admin/config", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/ai/admin/config",
      headers: { cookie: rootCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  it("6. Root without organizationId resolves billing subscription on /api/billing/subscription", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/billing/subscription",
      headers: { cookie: rootCookie },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  it("7. Non-root user without organization context is rejected with 403", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/onboarding/organization/me",
      headers: { cookie: nonOrgUserCookie },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.message).toContain("Organization context is required");
  });
});

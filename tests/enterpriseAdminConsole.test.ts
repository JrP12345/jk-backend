import { describe, it, expect, beforeAll, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { AIOrganizationConfig } from "../models/AIOrganizationConfig.ts";
import { aiAdminService } from "../services/ai/AIAdminService.ts";

describe("Phase 8: Enterprise AI Admin Console Tests", () => {
  let accessToken: string;
  let testUserId: string;
  let testOrgId: string;

  beforeAll(async () => {
    const email = `dr_admin_console_${Date.now()}@ananta.internal`;
    const password = "Password123!";

    const org = await (Organization as any).create({
      name: "Admin Console Test Hospital",
      email: `admin_console_${Date.now()}@ananta.internal`,
      phone: "+1999444222",
      address: "600 Admin Way",
      city: "San Francisco",
    });
    testOrgId = (org as any)._id.toString();

    const user = await (User as any).create({
      email,
      name: "Dr. AI Admin Console",
      password: await bcrypt.hash(password, 10),
      role: "root",
      organizationId: org._id
    });
    testUserId = (user as any)._id.toString();
    await OrgMember.create({ userId: user._id, organizationId: org._id, role: "root" });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password }
    });

    accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";
  });

  afterAll(async () => {
    await AIOrganizationConfig.deleteMany({ organizationId: testOrgId });
    await OrgMember.deleteMany({ userId: testUserId, organizationId: testOrgId });
    await User.deleteMany({ _id: testUserId });
    await Organization.deleteMany({ _id: testOrgId });
  });

  it("should get and update organization AI configuration with AIAdminService", async () => {
    const initial = await aiAdminService.getConfig(testOrgId);
    expect(initial.defaultModelAlias).toBe("CLINICAL_FAST");

    const updated = await aiAdminService.updateConfig(testOrgId, {
      defaultModelAlias: "CLINICAL_ACCURATE",
      monthlyTokenQuota: 20000000
    }, testUserId);

    expect(updated.defaultModelAlias).toBe("CLINICAL_ACCURATE");
    expect(updated.monthlyTokenQuota).toBe(20000000);
  });

  it("should query and update AI Admin Config via REST APIs (GET & PUT /api/ai/admin/config)", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: "/api/ai/admin/config",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` }
    });

    const getBody = JSON.parse(getRes.payload);
    expect(getRes.statusCode).toBe(200);
    expect(getBody.data.defaultModelAlias).toBeDefined();

    const putRes = await app.inject({
      method: "PUT",
      url: "/api/ai/admin/config",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        defaultModelAlias: "CLINICAL_REASONING",
        featureFlags: { enableStreaming: true, enableToolExecution: true }
      }
    });

    const putBody = JSON.parse(putRes.payload);
    expect(putRes.statusCode).toBe(200);
    expect(putBody.data.defaultModelAlias).toBe("CLINICAL_REASONING");
  });
});

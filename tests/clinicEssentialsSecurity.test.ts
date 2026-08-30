import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { generateAccessToken } from "../utilities/helpers.ts";

describe("Clinic Essentials — Patient Directory Tenant Isolation", () => {
  let orgAId: string;
  let orgBId: string;
  let staffAToken: string;
  let patientOrgAId: string;
  let patientOrgBId: string;

  beforeAll(async () => {
    await app.ready();

    orgAId = new mongoose.Types.ObjectId().toString();
    orgBId = new mongoose.Types.ObjectId().toString();

    const staffA = await User.create({
      name: "Staff Org A",
      email: "staff-a-ce@test.com",
      password: "hashed",
      role: "receptionist",
      isActive: true,
    });

    await OrgMember.create({
      userId: staffA._id,
      organizationId: orgAId,
      role: "receptionist",
    });

    staffAToken = generateAccessToken({
      id: staffA.id,
      email: staffA.email!,
      role: "receptionist",
      organization_id: orgAId,
    });

    const patientOrgA = await Patient.create({
      name: "Tenant Patient Alpha",
      phone: "9000000001",
      organizationId: orgAId,
      accountType: "walkin",
    });
    patientOrgAId = patientOrgA.id;

    const patientOrgB = await Patient.create({
      name: "Tenant Patient Beta",
      phone: "9000000002",
      organizationId: orgBId,
      accountType: "walkin",
    });
    patientOrgBId = patientOrgB.id;
  });

  it("should not return cross-tenant patients when staff search is used", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/patients?search=Tenant Patient",
      headers: { authorization: `Bearer ${staffAToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const ids = (body.data || []).map((p: { id?: string; _id?: string }) => p.id || p._id);

    expect(ids).toContain(patientOrgAId);
    expect(ids).not.toContain(patientOrgBId);
  });

  it("should block patient role from listing the patient directory", async () => {
    const portalUser = await User.create({
      name: "Portal User",
      phone: "9000000099",
      role: "patient",
      authMethod: "phone_otp",
      isActive: true,
    });

    const portalToken = generateAccessToken({
      id: portalUser.id,
      email: "",
      role: "patient",
      organization_id: orgAId,
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/patients",
      headers: { authorization: `Bearer ${portalToken}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("Clinic Essentials — Module Guard Enforcement", () => {
  let adminCookies: string[];
  let orgId: string;

  beforeAll(async () => {
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Module Guard CE Test Org",
        city: "Pune",
        admin_name: "Module Guard Admin",
        admin_email: `module-guard-ce-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.cookies.map((c: any) => `${c.name}=${c.value}`);
    orgId = JSON.parse(orgRes.body).data.organization.id;

    await ModuleRegistry.findOneAndUpdate(
      { organizationId: orgId, moduleKey: "patients" },
      { enabled: false },
      { upsert: true },
    );
  });

  it("should block patient directory API when patients module is disabled", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/patients",
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("Module disabled");
    expect(body.moduleKey).toBe("patients");
  });
});

import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import { Role } from "../models/Role.ts";

describe("Clinic Essentials Cycle 5 — location_manager Clinic Access", () => {
  let managerCookies: string[];

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `CM Locations Org ${Date.now()}`,
        city: "Pune",
        admin_name: "CM Locations Admin",
        admin_email: `cm-locations-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const adminCookies = (await provisionedAdminCookies(orgRes));

    await app.inject({
      method: "POST",
      url: "/api/onboarding/locations",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "CM Branch One", city: "Pune" },
    });

    const managerEmail = `cm-clinic-mgr-${Date.now()}@test.com`;
    await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Clinic Manager",
        email: managerEmail,
        password: "Password123!",
        role: "location_manager",
      },
    });

    await Role.updateOne(
      { name: "location_manager" },
      { $set: { permissions: ["VIEW_PATIENTS", "MANAGE_PATIENTS", "VIEW_APPOINTMENTS", "MANAGE_APPOINTMENTS", "MANAGE_QUEUE", "VIEW_LOCATIONS", "VIEW_BILLING", "MANAGE_BILLING", "MANAGE_MEDICINES", "VIEW_EHR"] } },
      { upsert: true }
    );

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: managerEmail, password: "Password123!" },
    });
    managerCookies = (loginRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
  });

  it("should allow location_manager to list clinic branches", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/onboarding/locations",
      headers: { cookie: managerCookies.join("; ") },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.length).toBeGreaterThan(0);
  });
});

describe("Clinic Essentials Cycle 5 — Service Catalog RBAC", () => {
  let managerCookies: string[];

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Catalog Org ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Catalog Admin",
        admin_email: `catalog-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const adminCookies = (await provisionedAdminCookies(orgRes));

    const managerEmail = `catalog-mgr-${Date.now()}@test.com`;
    await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Catalog Manager",
        email: managerEmail,
        password: "Password123!",
        role: "location_manager",
      },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: managerEmail, password: "Password123!" },
    });
    managerCookies = (loginRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
  });

  it("should allow location_manager with MANAGE_BILLING to create service catalog items", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/service-catalog",
      headers: { cookie: managerCookies.join("; ") },
      payload: {
        code: `SVC-${Date.now()}`,
        name: "OPD Consultation",
        department: "OPD",
        category: "consultation",
        price: 500,
        hsnSacCode: "999312",
        gstRate: 0,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

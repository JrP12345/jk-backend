import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { SterileTrayLog } from "../models/SterileTrayLog.ts";

describe("CSSD & Autoclave Operations Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let trayId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Apex Central Sterile & Surgical Supply",
        subdomain: `cssd-${Date.now()}`,
        admin_email: `admin_cssd_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Head of Sterilization & Infection Prevention",
        city: "Hyderabad",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgBody = JSON.parse(orgRes.body);
    orgId = orgBody.data.organization._id || orgBody.data.organization.id;
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Main OR Sterile Supply Complex",
        code: `CSSD-${Date.now()}`,
        city: "Hyderabad",
        address: "700 Autoclave Way",
        phone: "9100077000",
        email: "cssd@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (SterileTrayLog) {
      await SterileTrayLog.deleteMany({ clinicId });
    }
  });

  it("should log & register a sterile surgical tray batch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/cssd",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        trayBarcode: `TRAY-ORTHO-${Date.now()}`,
        trayName: "Major Orthopedic Joint Replacement Set #2",
        autoclaveUnitId: "AUTOCLAVE-BAY-03",
        sterilizationCycleNo: `CYC-2026-${Date.now().toString().slice(-4)}`,
        sterilizationMethod: "steam_autoclave",
        biologicalIndicatorStatus: "passed",
        chemicalIndicatorColor: "black_pass",
        expirationDays: 30,
        status: "sterile_storage",
        targetDepartment: "Operating Room Suite 4",
        technicianName: "Marcus Vance, Lead CSSD Tech",
        notes: "Steam exposure 134°C for 18 min. Biological indicator Geobacillus stearothermophilus passed 24h incubation.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trayName).toBe("Major Orthopedic Joint Replacement Set #2");
    expect(body.data.biologicalIndicatorStatus).toBe("passed");

    trayId = body.data.id;
  });

  it("should fetch CSSD sterilization logs with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/cssd?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.logs.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.totalPacks).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.indicatorPassRateRate).toBe(100);
  });

  it("should issue sterile tray to OR suite", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/cssd/${trayId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "issued_to_or",
        targetDepartment: "Operating Room Suite 2 - Cardiac Surgery",
        notes: "Dispatched to OR Suite 2 via sterile elevator.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("issued_to_or");
    expect(body.data.targetDepartment).toBe("Operating Room Suite 2 - Cardiac Surgery");
  });
});

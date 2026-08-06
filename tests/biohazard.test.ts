import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { BiohazardWasteLog } from "../models/BiohazardWasteLog.ts";

describe("Environmental Health & Biohazard Waste Management Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let logId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "EcoHealth Biohazard Environmental Solutions",
        subdomain: `biohazard-${Date.now()}`,
        admin_email: `admin_biohazard_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Environmental Safety Director",
        city: "Bengaluru",
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
        name: "Central Environmental Waste Facility",
        code: `HAZ-${Date.now()}`,
        city: "Bengaluru",
        address: "700 Biohazard Way",
        phone: "9100077000",
        email: "environmental@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (BiohazardWasteLog) {
      await BiohazardWasteLog.deleteMany({ clinicId });
    }
  });

  it("should log a new biohazard waste manifest collection", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/biohazard",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        manifestNumber: `HAZ-MAN-${Date.now()}`,
        wasteCategory: "yellow_pathological",
        weightKg: 42.5,
        originDepartment: "Surgical Suite 3",
        disposalMethod: "incineration",
        status: "collected",
        disposalVendor: "CleanBio Hazard Solutions Inc.",
        loggedBy: "Officer Marcus Vance",
        notes: "Pathological tissue waste safely sealed in double-walled yellow containers.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.wasteCategory).toBe("yellow_pathological");
    expect(body.data.weightKg).toBe(42.5);

    logId = body.data.id;
  });

  it("should fetch biohazard waste logs with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/biohazard?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.logs.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.totalMassKg).toBeGreaterThanOrEqual(42.5);
    expect(body.data.metrics.incinerationMassKg).toBeGreaterThanOrEqual(42.5);
  });

  it("should update biohazard log status to processed_disposed", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/biohazard/${logId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "processed_disposed",
        disposalVendor: "CleanBio Incineration Plant 4",
        notes: "Incinerated at 1100°C under EPA clean emissions standard.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("processed_disposed");
  });
});

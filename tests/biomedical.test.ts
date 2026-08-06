import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { BiomedicalAsset } from "../models/BiomedicalAsset.ts";

describe("Biomedical Equipment & Asset Maintenance Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let assetId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Biomedical Engineering Medical Center",
        subdomain: `biomedical-${Date.now()}`,
        admin_email: `admin_biomed_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Biomedical Lead Engineer",
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
        name: "Critical Care & Diagnostic Bio-Engineering Wing",
        code: `BIOMED-${Date.now()}`,
        city: "Bengaluru",
        address: "100 Innovation Park",
        phone: "9100066000",
        email: "biomed@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (BiomedicalAsset) {
      await BiomedicalAsset.deleteMany({ clinicId });
    }
  });

  it("should register a critical biomedical life-support equipment asset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/biomedical",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        assetTag: `BMED-VENT-${Date.now()}`,
        deviceName: "Mindray SV300 ICU Ventilator",
        category: "life_support",
        serialNumber: "SN-9988776655",
        manufacturer: "Mindray Medical",
        department: "ICU Ward A",
        location: "Bed 10",
        operationalStatus: "operational",
        riskClassification: "high_risk_critical",
        nextCalibrationDueDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        maintenanceContact: "Lead Bio-Engineer Desk",
        notes: "Passed annual flow sensor calibration.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.deviceName).toBe("Mindray SV300 ICU Ventilator");
    expect(body.data.riskClassification).toBe("high_risk_critical");

    assetId = body.data.id;
  });

  it("should fetch biomedical equipment list with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/biomedical?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.assets.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.operationalCount).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.highRiskCount).toBeGreaterThanOrEqual(1);
  });

  it("should update asset maintenance status to under_maintenance", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/biomedical/${assetId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        operationalStatus: "under_maintenance",
        notes: "Scheduled preventive maintenance & oxygen sensor replacement.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.operationalStatus).toBe("under_maintenance");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { OccupationalHealthRecord } from "../models/OccupationalHealthRecord.ts";

describe("Occupational Health & Staff Wellness Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let recordId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Metropolitan Healthcare Staff Wellness Center",
        subdomain: `occ-health-${Date.now()}`,
        admin_email: `admin_occ_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Director of Occupational Safety & Health",
        city: "Chennai",
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
        name: "Staff Occupational Health & Medical Clearance Clinic",
        code: `OCC-${Date.now()}`,
        city: "Chennai",
        address: "900 Wellness Parkway",
        phone: "9100088000",
        email: "wellness@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (OccupationalHealthRecord) {
      await OccupationalHealthRecord.deleteMany({ clinicId });
    }
  });

  it("should log a staff annual health exam & immunization record", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/occupational-health",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        employeeId: `EMP-NURSE-${Date.now()}`,
        employeeName: "Sister Katherine O'Connor, RN",
        department: "Emergency Department & Trauma Bay",
        recordType: "annual_health_exam",
        immunizationStatus: "fully_compliant",
        radiationDosimetrymSv: 0.12,
        needleStickProtocolStatus: "none",
        fitnessStatus: "fit_for_unrestricted_duty",
        examiningPhysician: "Dr. Sarah Jenkins, Occupational Health",
        notes: "Hepatitis B antibody titer >100 mIU/mL. Annual TB QuantiFERON test negative. Fit for unrestricted clinical duty.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.employeeName).toBe("Sister Katherine O'Connor, RN");
    expect(body.data.immunizationStatus).toBe("fully_compliant");

    recordId = body.data.id;
  });

  it("should fetch occupational health records with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/occupational-health?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.records.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.immunizationComplianceRate).toBe(100);
    expect(body.data.metrics.fitForDutyCount).toBeGreaterThanOrEqual(1);
  });

  it("should update needle-stick incident protocol status", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/occupational-health/${recordId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        needleStickProtocolStatus: "cleared",
        notes: "PEP 28-day regimen completed. Baseline, 6-week, and 12-week HIV/HCV PCR tests clear.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.needleStickProtocolStatus).toBe("cleared");
  });
});

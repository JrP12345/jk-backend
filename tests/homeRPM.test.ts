import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { HomeRPMRecord } from "../models/HomeRPMRecord.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";

describe("Home Healthcare & Outpatient Remote Patient Monitoring (RPM) Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let rpmRecordId: string;
  let patientId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "St. Jude Home Healthcare & Remote Monitoring Network",
        subdomain: `home-rpm-${Date.now()}`,
        admin_email: `admin_rpm_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Chief of Outpatient & Community Nursing",
        city: "Mumbai",
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
        name: "Community Health & Cellular RPM Care Command",
        code: `RPM-${Date.now()}`,
        city: "Mumbai",
        address: "500 Wellness Highway",
        phone: "9100099000",
        email: "homerpm@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    const patientUser = await User.create({
      name: "Robert Vance, Sr.",
      email: `rpm_patient_${Date.now()}@ananta.internal`,
      password: "test-password",
      role: "patient",
    });
    const patient = await Patient.create({ userId: patientUser._id, organizationId: orgId });
    patientId = patient._id.toString();
  });

  afterAll(async () => {
    if (HomeRPMRecord) {
      await HomeRPMRecord.deleteMany({ clinicId });
    }
    const patientDoc = await Patient.findById(patientId).select("userId").lean();
    await Patient.deleteMany({ _id: patientId });
    if (patientDoc?.userId) await User.deleteMany({ _id: patientDoc.userId });
  });

  it("should enroll patient in home RPM hypertension care plan", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/home-rpm",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        patientName: "Robert Vance, Sr.",
        carePlanType: "hypertension_management",
        assignedNurse: "Nurse Claire Bennett, RN (Home Care Dispatch)",
        deviceSerialNumber: `RPM-CELL-${Date.now()}`,
        latestVitals: {
          systolicBP: 155,
          diastolicBP: 95,
          spO2Percent: 97,
          bloodGlucoseMgDl: 110,
          heartRateBpm: 76,
        },
        address: "742 Evergreen Terrace, Sector 4",
        notes: "Cellular blood pressure cuff paired. Daily morning vitals sync required.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patientName).toBe("Robert Vance, Sr.");
    expect(body.data.carePlanType).toBe("hypertension_management");
    expect(body.data.vitalAlertSeverity).toBe("borderline");

    rpmRecordId = body.data.id;
  });

  it("should fetch home RPM records with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/home-rpm?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.records.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.totalPatients).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.activeRPMDevices).toBeGreaterThanOrEqual(1);
  });

  it("should sync cellular vitals & trigger critical alert when SpO2 drops < 90%", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/home-rpm/${rpmRecordId}/vitals`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        spO2Percent: 88,
        systolicBP: 185,
        notes: "Cellular O2 sensor detected acute desaturation to 88% SpO2. Emergency dispatch alert triggered.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.vitalAlertSeverity).toBe("critical_alert");
    expect(body.data.latestVitals.spO2Percent).toBe(88);
  });
});

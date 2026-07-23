import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { ObservationAlert } from "../models/ObservationAlert.ts";

describe("Observation Analytics & NEWS2 Scoring Platform Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let encounterId: string;
  let doctorUserId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Observation Scoring General Hospital",
        city: "Mumbai",
        admin_name: "Scoring Admin",
        admin_email: "scoring-admin@test.com",
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];
    const adminUser = await User.findOne({ email: "scoring-admin@test.com" });
    doctorUserId = adminUser!._id.toString();

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "ICU Ward",
        city: "Mumbai",
        address: "100 ICU Drive",
        phone: "9119119111",
        email: "icu@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Charlie Patient NEWS2",
        email: "charlie.news2@patient.com",
        password: "Password123",
        phone: "9665544332",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    const orgId = JSON.parse(orgRes.body).data.organization.id;
    await Patient.findByIdAndUpdate(patientId, { organizationId: orgId });

    // 4. Create Encounter
    const encRes = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        encounterType: "ipd",
      },
    });
    expect(encRes.statusCode).toBe(201);
    encounterId = JSON.parse(encRes.body).data.id;
  });

  // ─── Test 1: Severe Deterioration Score & °F -> °C Normalization ────────
  it("should calculate High risk NEWS2 score (>=7) and trigger emergency ObservationAlert", async () => {
    // Seed abnormal vitals: RR 26 (3), SpO2 88% (3), Oxygen (2), Systolic BP 85 (3), Pulse 135 (3), AVPU Pain (3), Temp 103°F = 39.4°C (2)
    const orgId = (await Encounter.findById(encounterId))?.organizationId;
    await Observation.insertMany([
      { organizationId: orgId, clinicId, encounterId, patientId, recordedBy: doctorUserId, code: "RR", name: "Respiration Rate", value: 26, unit: "breaths/min" },
      { organizationId: orgId, clinicId, encounterId, patientId, recordedBy: doctorUserId, code: "SPO2", name: "SpO2", value: 88, unit: "%" },
      { organizationId: orgId, clinicId, encounterId, patientId, recordedBy: doctorUserId, code: "OXYGEN", name: "Supplemental Oxygen", value: "Supplemental Oxygen" },
      { organizationId: orgId, clinicId, encounterId, patientId, recordedBy: doctorUserId, code: "BP_SYS", name: "Systolic BP", value: 85, unit: "mmHg" },
      { organizationId: orgId, clinicId, encounterId, patientId, recordedBy: doctorUserId, code: "PULSE", name: "Pulse Rate", value: 135, unit: "bpm" },
      { organizationId: orgId, clinicId, encounterId, patientId, recordedBy: doctorUserId, code: "AVPU", name: "Consciousness", value: "Pain" },
      { organizationId: orgId, clinicId, encounterId, patientId, recordedBy: doctorUserId, code: "TEMP", name: "Temperature", value: 103, unit: "F" },
    ]);

    const res = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/evaluate-score`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { algorithmId: "NEWS2" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.score.riskCategory).toBe("High");
    expect(body.data.score.totalScore).toBeGreaterThanOrEqual(15);
    expect(body.data.alert).not.toBeNull();
    expect(body.data.alert.severity).toBe("emergency");

    // Verify temp normalized to 39.4°C
    const tempBreakdown = body.data.score.parameterBreakdown.find((p: any) => p.parameter === "Temperature");
    expect(tempBreakdown.normalizedValue).toBe(39.4);
  });

  // ─── Test 2: Alert Acknowledgment Lifecycle ──────────────────────────────
  it("should update ObservationAlert status from 'open' to 'acknowledged'", async () => {
    const alert = await ObservationAlert.findOne({ encounterId });
    expect(alert).not.toBeNull();
    expect(alert?.status).toBe("open");

    const res = await app.inject({
      method: "POST",
      url: `/api/alerts/${alert!._id.toString()}/acknowledge`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { action: "acknowledge" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe("acknowledged");
    expect(body.data.acknowledgedAt).not.toBeNull();
  });

  // ─── Test 3: Vital Sign Time-Series Trends ────────────────────────────────
  it("should aggregate time-series vital trends for patient charting", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/vital-trends?days=30`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.SPO2).toBeDefined();
    expect(body.data.SPO2.length).toBeGreaterThanOrEqual(1);
    expect(body.data.TEMP).toBeDefined();
  });
});

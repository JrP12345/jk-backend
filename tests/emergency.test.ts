import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { EmergencyTriage } from "../models/EmergencyTriage.ts";
import { recommendESILevel } from "../controllers/emergency.ts";

describe("Emergency Department (ED) Triage Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Trauma & Emergency Center",
        city: "Delhi",
        admin_name: "ED Admin",
        admin_email: `ed_admin_${Date.now()}@emergency.internal`,
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Level 1 Trauma Emergency Department",
        city: "Delhi",
        address: "100 Acute Care Expressway",
        phone: "9811122233",
        email: "ed-triage@emergency.internal",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Emergency Patient Rahul",
        email: `rahul_ed_${Date.now()}@patient.com`,
        phone: "9123456789",
        password: "Password123",
        role: "patient",
      },
    });
    expect(patientRes.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
  });

  it("should calculate correct ESI Acuity levels based on vital signs & chief complaint", () => {
    // Level 1: Cardiac arrest / GCS < 9
    expect(recommendESILevel({ gcsScore: 7, spo2: 84 }, "Cardiac Arrest")).toBe(1);

    // Level 2: Chest pain / SpO2 < 92
    expect(recommendESILevel({ spo2: 90, heartRate: 125 }, "Crushing chest pain")).toBe(2);

    // Level 3: Abdominal pain / Fever
    expect(recommendESILevel({ temperature: 39.0 }, "Severe abdominal pain")).toBe(3);

    // Level 4: Simple laceration / suture
    expect(recommendESILevel({ spo2: 98, heartRate: 72 }, "Finger laceration needing suture")).toBe(4);
  });

  it("should register ED triage intake via POST /api/emergency/triage", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/emergency/triage",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        chiefComplaint: "Acute shortness of breath and chest tightness",
        triageCategory: "respiratory",
        vitals: {
          heartRate: 118,
          bpSys: 145,
          bpDia: 90,
          respRate: 28,
          spo2: 89,
          temperature: 37.8,
          gcsScore: 14,
        },
        assignedBay: "Trauma Bay 1",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.esiLevel).toBe(2);
    expect(body.data.assignedBay).toBe("Trauma Bay 1");
    expect(body.data.status).toBe("triaged");
  });

  it("should list ED triage queue sorted by ESI level via GET /api/emergency/triage", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/emergency/triage?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].esiLevel).toBe(2);
  });

  it("should update triage status and assigned bay via PUT /api/emergency/triage/:id", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/emergency/triage?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    const triageItem = JSON.parse(listRes.body).data[0];
    const triageId = triageItem._id || triageItem.id;

    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/emergency/triage/${triageId}`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "under_treatment",
        assignedBay: "Resuscitation Bay A",
        notes: "Patient stabilized on high-flow oxygen.",
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body).data;
    expect(updated.status).toBe("under_treatment");
    expect(updated.assignedBay).toBe("Resuscitation Bay A");
  });
});

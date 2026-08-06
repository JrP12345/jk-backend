import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";

describe("Outpatient Consultation & Clinical Note Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let doctorUserId: string;
  let encounterId: string;
  let noteId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "St. Jude Multispecialty Hospital",
        city: "Mumbai",
        admin_name: "Clinical Admin",
        admin_email: `opd_admin_${Date.now()}@stjude.internal`,
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
        name: "General OPD Consultation Clinic",
        city: "Mumbai",
        address: "100 Medical Center Drive",
        phone: "9600055500",
        email: "opd@stjude.internal",
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
        name: "OPD Patient Sunita",
        email: `sunita_opd_${Date.now()}@patient.com`,
        phone: "9887766554",
        password: "Password123",
        role: "patient",
      },
    });
    expect(patientRes.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const { Patient: PatientModel } = await import("../models/Patient.ts");
    const patientDoc = await PatientModel.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    // 4. Register Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Seth",
        email: `dr.vikram_${Date.now()}@hospital.com`,
        specialization: "Internal Medicine",
        phone: "9123456789",
        role: "doctor",
        password: "Password123",
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorUserId = JSON.parse(docRes.body).data.id;
  });

  it("should create an active OPD consultation encounter via POST /api/encounters", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        doctorId: doctorUserId,
        encounterType: "opd",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("in_progress");
    expect(body.data.encounterType).toBe("opd");
    encounterId = body.data.id || body.data._id;
  });

  it("should save draft SOAP clinical note via POST /api/clinical-notes", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clinical-notes",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        encounterId,
        patientId,
        chiefComplaint: "Persistent dry cough and mild fever for 4 days",
        historyOfPresentIllness: "Patient reports onset of symptoms after traveling.",
        symptoms: ["Cough", "Fever", "Fatigue"],
        physicalExamination: "Chest auscultation clear. Throat slightly erythematous.",
        diagnoses: ["Acute Upper Respiratory Infection (J06.9)"],
        severity: "mild",
        treatmentPlan: "Rest, oral hydration, paracetamol 500mg as needed.",
        vitals: {
          bpSystolic: 120,
          bpDiastolic: 80,
          pulseRate: 78,
          spO2: 98,
          temperatureF: 99.2,
        },
        prescriptions: [
          { name: "Paracetamol 500mg", dosage: "1 tablet", frequency: "1-0-1", duration: "5 days" },
        ],
        followUpDate: new Date(Date.now() + 7 * 86400000).toISOString(),
        followUpInstructions: "Return if fever persists beyond 3 days.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subjective.chiefComplaint).toContain("Persistent dry cough");
    expect(body.data.status).toBe("draft");
    noteId = body.data._id || body.data.id;
  });

  it("should sign and lock clinical note via PUT /api/clinical-notes/:id/sign", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/clinical-notes/${noteId}/sign`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("signed");
    expect(body.data.signature.signedAt).toBeDefined();
  });

  it("should retrieve patient clinical note history via GET /api/patients/:id/clinical-notes/history", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/clinical-notes/history`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].status).toBe("signed");
  });
});

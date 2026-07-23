import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Observation } from "../models/Observation.ts";
import { Prescription } from "../models/Prescription.ts";

describe("Enterprise Clinical Documentation Workspace Integration Tests", () => {
  let adminCookies: string[] = [];
  let doctorCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let doctorUserId: string;
  let encounterId: string;
  let draftNoteId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Clinical Workspace General Hospital",
        city: "Delhi",
        admin_name: "Workspace Admin",
        admin_email: "ws-admin@test.com",
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
        name: "Workspace OPD Branch",
        city: "Delhi",
        address: "50 Clinical Way",
        phone: "9112233445",
        email: "opd@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Create Doctor & Grant MANAGE_CLINICAL_NOTES + VIEW_EHR
    const doctorRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Patel",
        email: "vikram.patel@wstest.com",
        password: "Password123",
        specialization: "Internal Medicine",
      },
    });
    expect(doctorRes.statusCode).toBe(201);

    const docUser = await User.findOne({ email: "vikram.patel@wstest.com" });
    expect(docUser).not.toBeNull();
    doctorUserId = docUser!._id.toString();

    // Login as Doctor
    const doctorLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "vikram.patel@wstest.com",
        password: "Password123",
      },
    });
    expect(doctorLogin.statusCode).toBe(200);
    doctorCookies = doctorLogin.headers["set-cookie"] as string[];

    // 4. Register Patient
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Alice Patient WS",
        email: "alice.ws@patient.com",
        password: "Password123",
        phone: "9887766554",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    const orgId = JSON.parse(orgRes.body).data.organization.id;
    await Patient.findByIdAndUpdate(patientId, { organizationId: orgId });
  });

  // ─── Test 1: Create Encounter ─────────────────────────────────────────────
  it("should create a new clinical Encounter aggregate root", async () => {
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
    encounterId = body.data.id;
  });

  // ─── Test 2: Save Draft SOAP Note ─────────────────────────────────────────
  it("should record generic vitals observations and draft SOAP note", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/clinical-notes",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        encounterId,
        patientId,
        chiefComplaint: "Severe fever & chills",
        historyOfPresentIllness: "Symptoms started 2 days ago.",
        symptoms: ["Fever", "Chills", "Myalgia"],
        vitals: {
          bpSystolic: 120,
          bpDiastolic: 80,
          pulseRate: 88,
          spO2: 98,
          temperatureF: 101.2,
        },
        physicalExamination: "Febrile, throat clear, lungs clear to auscultation.",
        diagnoses: [
          { code: "A90", codingSystem: "ICD-10", description: "Dengue Fever", status: "active" },
        ],
        severity: "moderate",
        treatmentPlan: "Hydration, antipyretics, monitor platelet count.",
        prescriptions: [
          { name: "Paracetamol", dosage: "650mg", frequency: "1-1-1", duration: "5 days", instructions: "After food" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe("draft");
    expect(body.data.version).toBe(1);
    draftNoteId = body.data.id;

    // Verify Observations created (BP, HR, SPO2, TEMP)
    const obsCount = await Observation.countDocuments({ encounterId });
    expect(obsCount).toBe(4);

    // Verify Prescriptions created
    const rxCount = await Prescription.countDocuments({ encounterId });
    expect(rxCount).toBe(1);
  });

  // ─── Test 3: Sign Clinical Note ───────────────────────────────────────────
  it("should sign and lock clinical note", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/clinical-notes/${draftNoteId}/sign`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe("signed");
    expect(body.data.signature.signedAt).not.toBeNull();

    // Verify Encounter is completed
    const enc = await Encounter.findById(encounterId);
    expect(enc?.status).toBe("completed");
  });

  // ─── Test 4: Amend Signed Note ────────────────────────────────────────────
  it("should create version 2 amendment linked to parent note", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/clinical-notes/${draftNoteId}/amend`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        amendmentReason: "Added dengue serology lab recommendation",
        subjective: {
          chiefComplaint: "Severe fever, chills & retro-orbital pain",
          symptoms: ["Fever", "Chills", "Retro-orbital pain"],
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.version).toBe(2);
    expect(body.data.parentNoteId).toBe(draftNoteId);
    expect(body.data.isLatest).toBe(true);

    // Verify parent note is no longer isLatest
    const parentNote = await ClinicalNote.findById(draftNoteId);
    expect(parentNote?.isLatest).toBe(false);
    expect(parentNote?.status).toBe("amended");
  });

  // ─── Test 5: EHR Timeline Integration ─────────────────────────────────────
  it("should populate Longitudinal EHR Timeline with latest amended SOAP note", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.events.length).toBeGreaterThanOrEqual(1);

    const soapEvent = body.data.events.find((e: any) => e.displayMetadata.statusLabel === "Signed v2");
    expect(soapEvent).toBeDefined();
    expect(soapEvent.title).toMatch(/Dengue Fever/i);
    expect(soapEvent.clinicalConcepts.vitals.BP).toBe("120/80 mmHg");
  });
});

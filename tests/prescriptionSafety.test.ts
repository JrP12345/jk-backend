import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Prescription } from "../models/Prescription.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";

describe("Enterprise Clinical Decision Support (CDS) Platform Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let doctorUserId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "CDS Platform Hospital",
        city: "Bangalore",
        admin_name: "CDS Admin",
        admin_email: "cds-admin@test.com",
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
        name: "CDS Main Ward",
        city: "Bangalore",
        address: "77 Safety Way",
        phone: "9988776655",
        email: "cds@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Create Doctor
    const doctorRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Ananya Sharma",
        email: "ananya.sharma@cdstest.com",
        password: "Password123",
        specialization: "Clinical Pharmacology",
      },
    });
    expect(doctorRes.statusCode).toBe(201);

    const docUser = await User.findOne({ email: "ananya.sharma@cdstest.com" });
    expect(docUser).not.toBeNull();
    doctorUserId = docUser!._id.toString();

    // 4. Register Patient with allergy "Penicillin"
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Bob Patient CDS",
        email: "bob.cds@patient.com",
        password: "Password123",
        phone: "9776655443",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    const orgId = JSON.parse(orgRes.body).data.organization.id;
    await Patient.findByIdAndUpdate(patientId, {
      organizationId: orgId,
      allergies: ["Penicillin"],
    });

    // 5. Seed an active prescription "Warfarin 5mg" for patient
    await Prescription.create({
      organizationId: orgId,
      clinicId,
      encounterId: "000000000000000000000000",
      patientId,
      doctorId: doctorUserId,
      medicineName: "Warfarin",
      dosage: "5mg",
      frequency: "1-0-0",
      duration: "30 days",
      status: "active",
    });
  });

  // ─── Test 1: Patient Allergy Rule Execution ──────────────────────────────
  it("should trigger ALLERGY_WARNING when proposing Penicillin derivative", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/prescriptions/evaluate-safety",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId,
        proposedPrescriptions: [{ medicineName: "Amoxicillin 500mg" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.findings.length).toBeGreaterThanOrEqual(1);

    const allergyFinding = body.data.findings.find((f: any) => f.findingType === "allergy");
    expect(allergyFinding).toBeDefined();
    expect(allergyFinding.severity).toBe("critical");
    expect(allergyFinding.systemAction).toBe("override_required");
    expect(allergyFinding.recommendation).toMatch(/discontinue/i);
  });

  // ─── Test 2: Drug-Drug Interaction Rule Execution ────────────────────────
  it("should trigger DRUG_INTERACTION when proposing Aspirin alongside active Warfarin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/prescriptions/evaluate-safety",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId,
        proposedPrescriptions: [{ medicineName: "Aspirin 75mg" }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.hasOverrideRequired).toBe(true);

    const intFinding = body.data.findings.find((f: any) => f.findingType === "interaction");
    expect(intFinding).toBeDefined();
    expect(intFinding.title).toMatch(/Hemorrhage/i);
    expect(intFinding.evidence).toMatch(/FDA Black Box/i);
  });

  // ─── Test 3: Duplicate Therapy Rule Execution ─────────────────────────────
  it("should trigger DUPLICATE_THERAPY alert for duplicate active ingredients", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/prescriptions/evaluate-safety",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId,
        proposedPrescriptions: [
          { medicineName: "Crocin 650mg" },
          { medicineName: "Paracetamol 500mg" },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const dupFinding = body.data.findings.find((f: any) => f.findingType === "duplicate_therapy");
    expect(dupFinding).toBeDefined();
    expect(dupFinding.title).toMatch(/PARACETAMOL/i);
  });

  // ─── Test 4: Persist Immutable CDSEvaluation Snapshot with Override ────────
  it("should persist immutable CDSEvaluation snapshot document with clinician justification", async () => {
    const evalRes = await app.inject({
      method: "POST",
      url: "/api/prescriptions/evaluate-safety",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId,
        proposedPrescriptions: [{ medicineName: "Aspirin 75mg" }],
      },
    });
    const findings = JSON.parse(evalRes.body).data.findings;

    const overrideRes = await app.inject({
      method: "POST",
      url: "/api/prescriptions/override-evaluation",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        findings,
        clinicianDecision: "overridden",
        overrideReason: "Co-prescribed for post-PCI antiplatelet therapy under INR monitoring.",
      },
    });

    expect(overrideRes.statusCode).toBe(201);
    const body = JSON.parse(overrideRes.body);
    expect(body.data.interactionDatasetVersion).toBe("2026.07.22");
    expect(body.data.clinicianDecision).toBe("overridden");
    expect(body.data.overrideReason).toMatch(/post-PCI/i);

    const count = await CDSEvaluation.countDocuments({ patientId });
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

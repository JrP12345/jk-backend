import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Observation } from "../models/Observation.ts";
import { ObservationScore } from "../models/ObservationScore.ts";
import { Prescription } from "../models/Prescription.ts";
import { MedicationAdministration } from "../models/MedicationAdministration.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { Admission } from "../models/Admission.ts";
import { Bed } from "../models/Bed.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";

describe("Discharge Summary Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let encounterId: string;
  let orgId: string;
  let adminUserId: string;
  let documentId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Discharge General Hospital",
        city: "Hyderabad",
        admin_name: "Discharge Admin",
        admin_email: "discharge-admin@test.com",
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];
    orgId = JSON.parse(orgRes.body).data.organization.id;
    const adminUser = await User.findOne({ email: "discharge-admin@test.com" });
    adminUserId = adminUser!._id.toString();

    // Enable all modules for the test organization so admissions & discharge summary provider run
    await ModuleRegistry.updateMany({ organizationId: orgId }, { $set: { enabled: true } });

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Inpatient Ward B",
        city: "Hyderabad",
        address: "400 General Hospital Rd",
        phone: "9100088000",
        email: "ward-b@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Discharge Patient Bob",
        email: "bob.discharge@patient.com",
        password: "Password123",
        phone: "9009988776",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
    await Patient.findByIdAndUpdate(patientId, { organizationId: orgId });

    // 4. Create Encounter (IPD)
    const encRes = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, patientId, encounterType: "ipd" },
    });
    expect(encRes.statusCode).toBe(201);
    encounterId = JSON.parse(encRes.body).data.id;

    // 5. Seed Bed & Admission
    const bed = await Bed.create({
      clinicId,
      bedNumber: "BED-B101",
      wardName: "ICU Ward B",
      status: "occupied",
      pricePerDay: 2000,
    });
    await Admission.create({
      clinicId,
      patientId,
      bedId: bed._id,
      doctorInCharge: adminUserId,
      admissionDate: new Date(Date.now() - 3 * 24 * 3600 * 1000), // 3 days ago
      reasonForAdmission: "Severe Community-Acquired Pneumonia",
      status: "admitted",
    });

    // 6. Seed Signed Clinical Note with Diagnosis
    await ClinicalNote.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      doctorId: adminUserId,
      version: 1,
      isLatest: true,
      subjective: { chiefComplaint: "Fever and shortness of breath" },
      objective: { physicalExamination: "Crackles in right lower lung field" },
      assessment: {
        diagnoses: [
          { code: "J18.9", description: "Pneumonia, unspecified organism", codingSystem: "ICD-10", status: "active" },
        ],
        severity: "acute",
      },
      plan: { treatmentPlan: "IV Antibiotic therapy + O2 support" },
      status: "signed",
      signature: { signerId: adminUserId, signerName: "Discharge Admin", signedAt: new Date() },
    });

    // 7. Seed Observations & Score
    await Observation.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      recordedBy: adminUserId,
      code: "SPO2",
      name: "Oxygen Saturation",
      value: "93%",
      unit: "%",
      recordedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000),
    });
    await Observation.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      recordedBy: adminUserId,
      code: "SPO2",
      name: "Oxygen Saturation",
      value: "98%",
      unit: "%",
      recordedAt: new Date(),
    });
    await ObservationScore.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      algorithmId: "NEWS2",
      algorithmVersion: "1.0.0",
      totalScore: 1,
      riskCategory: "Low",
      isComplete: true,
      evaluatedAt: new Date(),
    });

    // 8. Seed Prescription & MAR
    const rx = await Prescription.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      doctorId: adminUserId,
      medicineName: "Ceftriaxone 1g",
      dosage: "1g",
      frequency: "1-0-1",
      duration: "5 days",
      instructions: "IV infusion over 30 mins",
      status: "active",
    });
    await MedicationAdministration.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      prescriptionId: rx._id,
      patientId,
      medicineName: "Ceftriaxone 1g",
      prescribedDose: "1g",
      doseGiven: "1g",
      route: "iv",
      scheduledTime: new Date(),
      administeredTime: new Date(),
      administeredBy: adminUserId,
      recordedBy: adminUserId,
      status: "administered",
    });

    // 9. Seed Lab Order & Result
    const labTest = await LabTest.create({
      clinicId,
      name: "C-Reactive Protein (CRP)",
      code: `CRP-${Date.now()}`,
      department: "Biochemistry",
      sampleType: "Blood",
      price: 400,
      normalRange: "< 5 mg/L",
    });
    await LabOrder.create({
      organizationId: orgId,
      clinicId,
      encounterId,
      patientId,
      testId: labTest._id,
      orderedBy: adminUserId,
      status: "result-uploaded",
      resultedBy: adminUserId,
      resultedAt: new Date(),
      result: {
        value: "4.2",
        unit: "mg/L",
        referenceRange: "< 5 mg/L",
        interpretation: "normal",
        isAbnormal: false,
      },
    });
  });

  // ─── Test 1: Compile Discharge Summary Draft ────────────────────────────────
  it("should compile a discharge summary aggregating across all 6 engines", async () => {
    const compileRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/discharge/compile`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(compileRes.statusCode).toBe(201);
    const doc = JSON.parse(compileRes.body).data;
    expect(doc.status).toBe("draft");
    expect(doc.encounterId).toBe(encounterId);
    documentId = doc.id;

    // Verify machine-assembled aggregated snapshot
    const agg = doc.aggregated;
    expect(agg.encounterSummary.encounterType).toBe("ipd");
    expect(agg.diagnoses.length).toBeGreaterThanOrEqual(1);
    expect(agg.diagnoses[0].code).toBe("J18.9");
    expect(agg.vitalsOnAdmission).not.toBeNull();
    expect(agg.vitalsOnDischarge).not.toBeNull();
    expect(agg.news2Summary.finalScore).toBe(1);
    expect(agg.medications.length).toBeGreaterThanOrEqual(1);
    expect(agg.medications[0].medicineName).toBe("Ceftriaxone 1g");
    expect(agg.medications[0].administrationSummary).toContain("administered");
    expect(agg.labResults.length).toBeGreaterThanOrEqual(1);
    expect(agg.labResults[0].testName).toContain("C-Reactive Protein");
  });

  // ─── Test 2: Finalize Summary & Central Encounter Closure Invariant ───────
  it("should finalize discharge summary, generate snapshotHash, and close encounter", async () => {
    const finalizeRes = await app.inject({
      method: "PUT",
      url: `/api/discharge/${documentId}/finalize`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        primaryDiagnosis: "Resolved Community-Acquired Pneumonia (J18.9)",
        conditionOnDischarge: "Stable, afebrile, room air SpO2 98%",
        dischargeInstructions: "Complete oral antibiotic course. Return to clinic if fever recurs.",
        followUpPlan: "Follow up in OPD after 7 days.",
        medicationsOnDischarge: "Cefixime 200mg BD for 5 days.",
        restrictions: "Avoid strenuous exertion for 1 week.",
      },
    });

    expect(finalizeRes.statusCode).toBe(200);
    const doc = JSON.parse(finalizeRes.body).data;
    expect(doc.status).toBe("finalized");
    expect(doc.finalizedAt).not.toBeNull();

    // Verify SHA-256 snapshotHash fingerprint (64 hex chars)
    expect(doc.snapshotHash).toBeDefined();
    expect(doc.snapshotHash.length).toBe(64);

    // Verify Central Invariant: Encounter.status is now "closed"
    const encounter = await Encounter.findById(encounterId).lean() as any;
    expect(encounter.status).toBe("closed");
    expect(encounter.endedAt).not.toBeNull();
  });

  // ─── Test 3: Lifecycle Enforcement & Countersigning ─────────────────────────
  it("should enforce lifecycle constraints and support optional countersigning", async () => {
    // Attempt re-compiling finalized document → 422
    const recompileRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/discharge/compile`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(recompileRes.statusCode).toBe(422);

    // Attempt re-finalizing finalized document → 422
    const refinalizeRes = await app.inject({
      method: "PUT",
      url: `/api/discharge/${documentId}/finalize`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        primaryDiagnosis: "Test",
        conditionOnDischarge: "Test",
        dischargeInstructions: "Test",
      },
    });
    expect(refinalizeRes.statusCode).toBe(422);

    // Countersign finalized document → 200
    const countersignRes = await app.inject({
      method: "PUT",
      url: `/api/discharge/${documentId}/countersign`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(countersignRes.statusCode).toBe(200);
    const doc = JSON.parse(countersignRes.body).data;
    expect(doc.status).toBe("countersigned");
    expect(doc.countersignedBy).not.toBeNull();
  });

  // ─── Test 4: Longitudinal Timeline Integration ──────────────────────────────
  it("should surface finalized discharge document on the patient's EHR timeline", async () => {
    const timelineRes = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline?includeFinancial=true`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(timelineRes.statusCode).toBe(200);
    const events = JSON.parse(timelineRes.body).data.events;
    expect(Array.isArray(events)).toBe(true);

    const dischargeEvent = events.find((e: any) => e.displayMetadata?.uiCategory === "discharge");
    expect(dischargeEvent).toBeDefined();
    expect(dischargeEvent.title).toContain("Pneumonia");
    expect(dischargeEvent.displayMetadata.badgeColor).toBe("purple");
    expect(dischargeEvent.clinicalMetadata.discharge).toBeDefined();
    expect(dischargeEvent.clinicalMetadata.discharge.snapshotHash).toHaveLength(64);
  });

  it("should support transferring admitted patient to another available bed via POST /api/admissions/:id/transfer-bed", async () => {
    // 1. Create 2 beds: Bed-101 (Occupied), Bed-102 (Available)
    const bed1Res = await app.inject({
      method: "POST",
      url: "/api/beds",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, wardName: "ICU", bedNumber: "ICU-101", pricePerDay: 5000 },
    });
    const bed1Id = JSON.parse(bed1Res.body).data.id;

    const bed2Res = await app.inject({
      method: "POST",
      url: "/api/beds",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, wardName: "General Ward", bedNumber: "GW-202", pricePerDay: 1500 },
    });
    const bed2Id = JSON.parse(bed2Res.body).data.id;

    // 2. Admit patient to ICU-101
    const admitRes = await app.inject({
      method: "POST",
      url: "/api/admissions",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        bedId: bed1Id,
        reasonForAdmission: "Acute respiratory distress",
        doctorInCharge: adminUserId,
      },
    });
    expect(admitRes.statusCode).toBe(201);
    const admissionId = JSON.parse(admitRes.body).data.id;

    // 3. Transfer patient from ICU-101 to GW-202
    const transferRes = await app.inject({
      method: "POST",
      url: `/api/admissions/${admissionId}/transfer-bed`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        targetBedId: bed2Id,
        reason: "Patient stabilized, step-down to General Ward",
      },
    });

    expect(transferRes.statusCode).toBe(200);
    const transferBody = JSON.parse(transferRes.body);
    expect(transferBody.success).toBe(true);

    // Verify bed statuses swapped
    const oldBed = await Bed.findById(bed1Id);
    const newBed = await Bed.findById(bed2Id);
    expect(oldBed!.status).toBe("available");
    expect(newBed!.status).toBe("occupied");
  });
});

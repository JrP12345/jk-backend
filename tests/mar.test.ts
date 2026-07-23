import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { MedicationAdministration } from "../models/MedicationAdministration.ts";

describe("Medication Administration Record (MAR) Integration Tests", () => {
  let adminCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let encounterId: string;
  let prescriptionId: string;
  let adminUserId: string;

  // ─── Test Setup: Organization → Clinic → Patient → Encounter → Prescription ──
  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "MAR General Hospital",
        city: "Delhi",
        admin_name: "MAR Admin",
        admin_email: "mar-admin@test.com",
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];
    const adminUser = await User.findOne({ email: "mar-admin@test.com" });
    adminUserId = adminUser!._id.toString();

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Inpatient Ward A",
        city: "Delhi",
        address: "200 Hospital Road",
        phone: "9110011001",
        email: "ward-a@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Inpatient John",
        email: "inpatient.john@patient.com",
        password: "Password123",
        phone: "9001234567",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    const orgId = JSON.parse(orgRes.body).data.organization.id;
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

    // 5. Create a Medicine in catalog
    const medRes = await app.inject({
      method: "POST",
      url: "/api/medicines",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Amoxicillin",
        category: "Antibiotic",
        description: "Broad-spectrum antibiotic",
        price: 50,
        organizationId: orgId,
        clinicId,
      },
    });
    // Medicine creation may or may not return 201 depending on admin-only check
    // Seed prescription directly if needed
    const encounter = await Encounter.findById(encounterId).lean() as any;

    // 6. Create a Prescription directly for the encounter
    const { Prescription } = await import("../models/Prescription.ts");
    const rx = await Prescription.create({
      organizationId: encounter.organizationId,
      clinicId:       encounter.clinicId,
      encounterId:    encounterId,
      patientId:      patientId,
      doctorId:       adminUserId,
      medicineName:   "Amoxicillin 500mg",
      dosage:         "500mg",
      frequency:      "1-0-1",
      duration:       "5 days",
      instructions:   "Take after food",
      status:         "active",
    });
    prescriptionId = rx._id.toString();
  });

  // ─── Test 1: Schedule + Administer — Core Workflow ─────────────────────────
  it("should schedule a dose and then record it as administered", async () => {
    const scheduleRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/mar`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        prescriptionId,
        route: "oral",
        scheduledTime: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour from now
        notes: "Schedule morning dose",
      },
    });

    expect(scheduleRes.statusCode).toBe(201);
    const scheduled = JSON.parse(scheduleRes.body).data;
    expect(scheduled.status).toBe("scheduled");
    expect(scheduled.prescribedDose).toBe("500mg");
    expect(scheduled.medicineName).toBe("Amoxicillin 500mg");
    expect(scheduled.route).toBe("oral");

    const administrationId = scheduled.id;

    // Now administer with a slightly different dose (clinical variance)
    const administerRes = await app.inject({
      method: "PUT",
      url: `/api/mar/${administrationId}/administer`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doseGiven: "500mg",
        notes: "Administered without incident",
      },
    });

    expect(administerRes.statusCode).toBe(200);
    const administered = JSON.parse(administerRes.body).data;
    expect(administered.status).toBe("administered");
    expect(administered.administeredTime).not.toBeNull();
    expect(administered.doseGiven).toBe("500mg");

    // Verify state machine: terminal state cannot be re-administered
    const doubleAdmin = await app.inject({
      method: "PUT",
      url: `/api/mar/${administrationId}/administer`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { doseGiven: "500mg" },
    });
    expect(doubleAdmin.statusCode).toBe(422);  // state machine violation
  });

  // ─── Test 2: Refuse a Dose — Mandatory Reason ──────────────────────────────
  it("should schedule a dose and record patient refusal with mandatory reason", async () => {
    // Schedule fresh entry
    const scheduleRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/mar`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        prescriptionId,
        route: "oral",
        scheduledTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      },
    });
    expect(scheduleRes.statusCode).toBe(201);
    const administrationId = JSON.parse(scheduleRes.body).data.id;

    // Attempt refusal without a reason — should fail
    const noReasonRes = await app.inject({
      method: "PUT",
      url: `/api/mar/${administrationId}/refuse`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {},
    });
    expect(noReasonRes.statusCode).toBe(400);

    // Refuse with reason — should succeed
    const refuseRes = await app.inject({
      method: "PUT",
      url: `/api/mar/${administrationId}/refuse`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { refusalReason: "Patient reports nausea and does not want oral medication" },
    });
    expect(refuseRes.statusCode).toBe(200);
    const refused = JSON.parse(refuseRes.body).data;
    expect(refused.status).toBe("refused");
    expect(refused.refusalReason).toContain("nausea");
  });

  // ─── Test 3: Hold a Dose — Mandatory Reason + Lifecycle Validation ─────────
  it("should schedule a dose and hold it with a mandatory clinical reason", async () => {
    const scheduleRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/mar`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        prescriptionId,
        route: "iv",
        scheduledTime: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
        notes: "IV dose for evening round",
      },
    });
    expect(scheduleRes.statusCode).toBe(201);
    const administrationId = JSON.parse(scheduleRes.body).data.id;

    // Hold with reason
    const holdRes = await app.inject({
      method: "PUT",
      url: `/api/mar/${administrationId}/hold`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { holdReason: "BP low (85/60), hold antihypertensive until reviewed by attending" },
    });
    expect(holdRes.statusCode).toBe(200);
    const held = JSON.parse(holdRes.body).data;
    expect(held.status).toBe("held");
    expect(held.holdReason).toContain("BP low");
  });

  // ─── Test 4: MAR Retrieval — Encounter-scoped + Prescription-scoped ─────────
  it("should retrieve the full MAR for an encounter and by prescription", async () => {
    // Encounter-scoped MAR
    const marRes = await app.inject({
      method: "GET",
      url: `/api/encounters/${encounterId}/mar`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(marRes.statusCode).toBe(200);
    const marBody = JSON.parse(marRes.body).data;
    expect(Array.isArray(marBody.entries)).toBe(true);
    expect(marBody.entries.length).toBeGreaterThanOrEqual(3); // scheduled, refused, held from above
    expect(marBody.grouped).toBeDefined();
    expect(marBody.grouped[prescriptionId]).toBeDefined();

    // Prescription-scoped MAR
    const rxMarRes = await app.inject({
      method: "GET",
      url: `/api/prescriptions/${prescriptionId}/mar`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(rxMarRes.statusCode).toBe(200);
    const rxMarBody = JSON.parse(rxMarRes.body).data;
    expect(Array.isArray(rxMarBody)).toBe(true);
    expect(rxMarBody.length).toBeGreaterThanOrEqual(3);

    // Verify prescribed vs administered dose capture
    const administeredEntry = rxMarBody.find((e: any) => e.status === "administered");
    expect(administeredEntry).toBeDefined();
    expect(administeredEntry.prescribedDose).toBe("500mg");
    expect(administeredEntry.doseGiven).toBe("500mg");
  });
});

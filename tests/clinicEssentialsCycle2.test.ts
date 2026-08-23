import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Prescription } from "../models/Prescription.ts";
import { Encounter } from "../models/Encounter.ts";
import { setupCeOrgFixture, bookWalkInAppointment, cookieHeader } from "./helpers/clinicEssentialsSetup.ts";

describe("Clinic Essentials Cycle 2 — Prescription Handoff", () => {
  let adminCookies: string[];
  let clinicId: string;
  let patientId: string;
  let doctorUserId: string;
  let encounterId: string;
  let prescriptionId: string;
  let medicineId: string;

  beforeAll(async () => {
    await app.ready();

    const fixture = await setupCeOrgFixture(app, "pharm-handoff", "Handoff Clinic");
    adminCookies = fixture.adminCookies;
    clinicId = fixture.clinicId;
    doctorUserId = fixture.doctorId;

    const appt = await bookWalkInAppointment(app, adminCookies, {
      clinicId,
      doctorId: doctorUserId,
      patientDetails: {
        name: "Rx Patient",
        dob: "1995-06-15",
        gender: "female",
        phone: "9000111222",
        email: `rx-patient-${Date.now()}@test.com`,
        password: "Password123!",
      },
    });
    expect(appt.statusCode).toBe(201);
    patientId = appt.patientId!;

    const medRes = await app.inject({
      method: "POST",
      url: "/api/medicines",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        name: "Paracetamol 500mg",
        genericName: "Paracetamol",
        stockQuantity: 100,
        price: 5,
        costPrice: 2,
        expiryDate: new Date(Date.now() + 365 * 86400000).toISOString(),
        batchNumber: "BATCH-RX-001",
      },
    });
    medicineId = JSON.parse(medRes.body).data.id;

    const encounterRes = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: { clinicId, patientId, doctorId: doctorUserId, encounterType: "opd" },
    });
    encounterId = JSON.parse(encounterRes.body).data.id;

    await app.inject({
      method: "POST",
      url: "/api/clinical-notes",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        encounterId,
        patientId,
        chiefComplaint: "Headache",
        prescriptions: [
          { name: "Paracetamol 500mg", dosage: "1 tablet", frequency: "1-0-1", duration: "3 days", medicineId },
        ],
      },
    });

    const rxDoc = await Prescription.findOne({ encounterId, status: "active" });
    expect(rxDoc).toBeTruthy();
    prescriptionId = rxDoc!._id.toString();
  });

  it("should expose active prescriptions on pending-prescriptions after clinical note draft", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pharmacy/pending-prescriptions?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const groups = JSON.parse(res.body).data;
    expect(groups.length).toBeGreaterThan(0);
    const group = groups.find((g: { encounterId: string }) => g.encounterId === encounterId);
    expect(group).toBeTruthy();
    expect(group.prescriptions.some((p: { id: string }) => p.id === prescriptionId)).toBe(true);
  });

  it("should mark prescriptions dispensed after pharmacy dispense", async () => {
    const dispenseRes = await app.inject({
      method: "POST",
      url: "/api/pharmacy/dispense",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId,
        clinicId,
        doctorId: doctorUserId,
        prescriptionIds: [prescriptionId],
        items: [{ medicineId, quantity: 10 }],
      },
    });

    expect(dispenseRes.statusCode).toBe(201);

    const updated = await Prescription.findById(prescriptionId);
    expect(updated?.status).toBe("dispensed");

    const pendingRes = await app.inject({
      method: "GET",
      url: `/api/pharmacy/pending-prescriptions?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    const groups = JSON.parse(pendingRes.body).data;
    const stillPending = groups.some((g: { prescriptions?: { id: string }[] }) =>
      g.prescriptions?.some((p) => p.id === prescriptionId)
    );
    expect(stillPending).toBe(false);
  });
});

describe("Clinic Essentials Cycle 2 — clinic_manager RBAC", () => {
  let managerCookies: string[];
  let clinicId: string;
  let doctorUserId: string;

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Clinic Manager Org ${Date.now()}`,
        city: "Pune",
        admin_name: "CM Admin",
        admin_email: `cm-admin-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const adminCookies = (orgRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);

    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "CM Clinic", city: "Pune" },
    });
    clinicId = JSON.parse(clinicRes.body).data.id;

    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr Queue CM",
        email: `dr-queue-cm-${Date.now()}@test.com`,
        password: "Password123!",
        specialization: "General",
      },
    });
    doctorUserId = JSON.parse(docRes.body).data.id;

    const managerEmail = `desk-manager-${Date.now()}@test.com`;
    const staffRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Desk Manager",
        email: managerEmail,
        password: "Password123!",
        role: "clinic_manager",
      },
    });
    expect(staffRes.statusCode).toBe(201);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: managerEmail, password: "Password123!" },
    });
    expect(loginRes.statusCode).toBe(200);
    managerCookies = (loginRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
  });

  it("should allow clinic_manager to search patients", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/patients",
      headers: { cookie: managerCookies.join("; ") },
    });
    expect(res.statusCode).toBe(200);
  });

  it("should allow clinic_manager to view queue status", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/queue/status?clinicId=${clinicId}&doctorId=${doctorUserId}`,
      headers: { cookie: managerCookies.join("; ") },
    });
    expect(res.statusCode).toBe(200);
  });

  it("should allow clinic_manager to list invoices", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/invoices",
      headers: { cookie: managerCookies.join("; ") },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("Clinic Essentials Cycle 2 — Encounter Billing Tenant Isolation", () => {
  let orgBCookies: string[];
  let orgAEncounterId: string;

  beforeAll(async () => {
    await app.ready();

    const orgARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Encounter Org A",
        city: "Mumbai",
        admin_name: "Enc Admin A",
        admin_email: `enc-a-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const orgACookies = (orgARes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    const orgAId = JSON.parse(orgARes.body).data.organization.id;

    const clinicARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: orgACookies.join("; ") },
      payload: { name: "Enc Clinic A", city: "Mumbai" },
    });
    const clinicAId = JSON.parse(clinicARes.body).data.id;

    const docARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: orgACookies.join("; ") },
      payload: {
        name: "Dr Enc A",
        email: `dr-enc-a-${Date.now()}@test.com`,
        password: "Password123!",
        specialization: "General",
      },
    });
    const docAId = JSON.parse(docARes.body).data.id;

    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: orgACookies.join("; ") },
      payload: { doctorId: docAId, clinicId: clinicAId, fees: 400, workingHours: "09:00 - 17:00" },
    });

    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: orgACookies.join("; ") },
      payload: {
        clinicId: clinicAId,
        doctorId: docAId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "walk-in",
        patientDetails: {
          name: "Enc Patient A",
          dob: "1990-01-01",
          gender: "male",
          phone: `9111${Date.now().toString().slice(-6)}`,
          email: `enc-patient-a-${Date.now()}@test.com`,
          password: "Password123!",
        },
      },
    });
    expect(apptRes.statusCode).toBe(201);
    const patientAId = JSON.parse(apptRes.body).data.patientId;

    const encounter = await Encounter.create({
      organizationId: orgAId,
      clinicId: clinicAId,
      patientId: patientAId,
      doctorId: docAId,
      encounterType: "opd",
      status: "completed",
    });
    orgAEncounterId = encounter._id.toString();

    const orgBRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Encounter Org B",
        city: "Delhi",
        admin_name: "Enc Admin B",
        admin_email: `enc-b-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    orgBCookies = (orgBRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
  });

  it("should block cross-tenant encounter charge preview", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/encounters/${orgAEncounterId}/charges-preview`,
      headers: { cookie: orgBCookies.join("; ") },
    });
    expect(res.statusCode).toBe(404);
  });

  it("should block cross-tenant auto-invoice generation", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/encounters/${orgAEncounterId}/auto-invoice`,
      headers: { cookie: orgBCookies.join("; ") },
    });
    expect(res.statusCode).toBe(404);
  });
});

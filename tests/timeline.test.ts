import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Role } from "../models/Role.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";
import { Invoice } from "../models/Invoice.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";

describe("Longitudinal EHR Domain Subsystem Integration Tests", () => {
  let adminCookies: string[] = [];
  let doctorCookies: string[] = [];
  let patientId: string;
  let clinicId: string;
  let doctorUserId: string;
  let orgId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "EHR Test General Hospital",
        city: "Mumbai",
        admin_name: "EHR Admin",
        admin_email: "ehr-admin@test.com",
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];
    orgId = JSON.parse(orgRes.body).data.organization.id;

    // Enable all modules for the test organization so Lab & Admission timeline providers run
    await ModuleRegistry.findOneAndUpdate(
      { organizationId: orgId, moduleKey: "laboratory" },
      { $set: { enabled: true } },
      { upsert: true }
    );

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "EHR Main Branch",
        city: "Mumbai",
        address: "100 EHR Way",
        phone: "9876543210",
        email: "ehr@hospital.com",
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
        name: "Dr. Sarah Lin",
        email: "sarah.lin@ehrtest.com",
        password: "Password123",
        specialization: "Cardiology",
      },
    });
    expect(doctorRes.statusCode).toBe(201);
    const doctorUser = await User.findOne({ email: "sarah.lin@ehrtest.com" });
    expect(doctorUser).not.toBeNull();
    doctorUserId = doctorUser!._id.toString();

    // Login as Doctor
    const doctorLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "sarah.lin@ehrtest.com",
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
        name: "John Doe EHR",
        email: "john.ehr@patient.com",
        password: "Password123",
        phone: "9123456789",
      },
    });
    expect(patientReg.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientReg.body).data.user.id;
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    expect(patientDoc).not.toBeNull();
    patientId = patientDoc!._id.toString();

    // Link Patient to Organization
    await Patient.findByIdAndUpdate(patientId, { organizationId: orgId, allergies: ["Penicillin"] });

    // 5. Seed OPD Appointment with Diagnosis & Prescriptions
    await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId: doctorUserId,
      patientId,
      appointmentTime: new Date("2026-07-20T10:00:00Z"),
      appointmentType: "walk-in",
      status: "completed",
      tokenNumber: 101,
      symptoms: "Chest tightness, fatigue",
      diagnosis: "Hypertension Stage 1",
      prescriptions: [{ name: "Amlodipine", dosage: "5mg", duration: "30 days" }],
    });

    // 6. Seed Lab Test & Lab Order
    const labTest = await LabTest.create({
      organizationId: orgId,
      clinicId,
      name: "ECG Standard 12-Lead",
      code: "ECG12-TEST",
      department: "Cardiology",
      sampleType: "Blood",
      price: 1500,
      normalRange: "Normal",
    });

    await LabOrder.create({
      organizationId: orgId,
      clinicId,
      patientId,
      doctorId: doctorUserId,
      testId: labTest._id,
      orderDate: new Date("2026-07-20T11:00:00Z"),
      status: "result-uploaded",
      resultValue: "Sinus Rhythm with Non-Specific ST Changes",
      resultNotes: "Follow up in 2 weeks",
    });

    // 7. Seed Invoice
    await Invoice.create({
      organizationId: orgId,
      invoiceNumber: "INV-EHR-001",
      clinicId,
      patientId,
      doctorId: doctorUserId,
      items: [{ description: "OPD Consultation", amount: 800 }],
      subtotal: 800,
      totalAmount: 800,
      status: "paid",
      paymentDate: new Date("2026-07-20T12:00:00Z"),
    });
  });

  // ─── Test 1: Admin fetches EHR timeline ──────────────────────────────────
  it("should return versioned EHR timeline with canonical events for admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline?includeFinancial=true`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.version).toBe(1);
    expect(Array.isArray(body.data.events)).toBe(true);
    expect(body.data.events.length).toBe(3); // Appointment, Lab, Invoice

    const firstEvent = body.data.events[0];
    expect(firstEvent).toHaveProperty("id");
    expect(firstEvent).toHaveProperty("type");
    expect(firstEvent).toHaveProperty("occurredAt");
    expect(firstEvent).toHaveProperty("sourceRef");
    expect(firstEvent).toHaveProperty("clinicalMetadata");
    expect(firstEvent).toHaveProperty("displayMetadata");
    expect(firstEvent).toHaveProperty("clinicalConcepts");
  });

  // ─── Test 2: Financial Isolation Toggle ──────────────────────────────
  it("should exclude billing events by default unless includeFinancial=true is set", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const types = body.data.events.map((e: any) => e.type);
    expect(types).not.toContain("billing");
    expect(body.data.events.length).toBe(2);
  });

  // ─── Test 3: Staff without VIEW_EHR is blocked ──────────────────────────
  it("should block staff without VIEW_EHR permission with 403 Forbidden", async () => {
    // 1. Create a Receptionist user (receptionist role lacks VIEW_EHR)
    const recepReg = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Recep Staff",
        email: "recep@ehrtest.com",
        password: "Password123",
        phone: "9988776655",
      },
    });
    expect(recepReg.statusCode).toBe(201);
    const recepUserId = JSON.parse(recepReg.body).data.user.id;
    await User.findByIdAndUpdate(recepUserId, { role: "receptionist", organization_id: orgId });

    // 2. Login as Receptionist
    const recepLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "recep@ehrtest.com",
        password: "Password123",
      },
    });
    const recepCookies = recepLogin.headers["set-cookie"] as string[];

    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline`,
      headers: { cookie: recepCookies.join("; ") },
    });

    expect(res.statusCode).toBe(403);
  });

  // ─── Test 4: Doctor granted VIEW_EHR can access ──────────────────────────
  it("should allow doctor with VIEW_EHR permission to access timeline", async () => {
    await Role.findOneAndUpdate(
      { name: "doctor" },
      { $set: { name: "doctor", permissions: ["VIEW_EHR"] } },
      { upsert: true }
    );

    const docLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "sarah.lin@ehrtest.com",
        password: "Password123",
      },
    });
    doctorCookies = docLogin.headers["set-cookie"] as string[];

    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline`,
      headers: { cookie: doctorCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
  });

  // ─── Test 5: Keyword Search (`q`) Filtering ─────────────────────────────
  it("should filter timeline events by search query `q`", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline?q=ECG`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.events.length).toBe(1);
    expect(body.data.events[0].title).toMatch(/ECG/i);
  });

  // ─── Test 6: Cursor Pagination ───────────────────────────────────────────
  it("should paginate timeline events with cursor and limit", async () => {
    const res1 = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline?limit=2&includeFinancial=true`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res1.statusCode).toBe(200);
    const body1 = JSON.parse(res1.body);
    expect(body1.data.returnedCount).toBe(2);
    expect(body1.data.hasMore).toBe(true);
    expect(body1.data.nextCursor).not.toBeNull();

    // Fetch page 2 using cursor
    const res2 = await app.inject({
      method: "GET",
      url: `/api/patients/${patientId}/timeline?limit=2&includeFinancial=true&cursor=${encodeURIComponent(body1.data.nextCursor)}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res2.statusCode).toBe(200);
    const body2 = JSON.parse(res2.body);
    expect(body2.data.returnedCount).toBe(1);
    expect(body2.data.hasMore).toBe(false);
  });
});

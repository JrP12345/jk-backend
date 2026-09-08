import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { OpdSession } from "../models/OpdSession.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";

describe("Doctor Break TV Sync & 1-Click Consolidated Outpatient Checkout Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let doctorUserId: string;
  let patient: any;
  let labTest: any;
  let appointmentId: string;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `CareFirst Health System ${Date.now()}`,
        city: "Bengaluru",
        admin_name: "CareFirst Admin",
        admin_email: `carefirst_${Date.now()}@health.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // 2. Setup Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "CareFirst Indiranagar Clinic",
        city: "Bengaluru",
        upiVpa: "carefirst@icici",
        merchantName: "CareFirst Clinics",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Ramesh Sharma",
        email: `ramesh_${Date.now()}@health.com`,
        password: "Password123",
        specialization: "General Medicine",
        qualification: "MBBS, MD",
        experience: 12,
        consultationFee: 600,
        contactNumber: "+919876543201",
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorId = docData.id;
    doctorUserId = docData.userId || docData.id;

    await DoctorAssignment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      fees: 750,
      workingHours: "[]",
      isActive: true,
    });

    // 4. Setup Patient
    const patUserRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Sunil Kumar",
        email: `sunil_${Date.now()}@health.com`,
        password: "Password123",
        phone: "+919844433322",
        role: "patient",
      },
    });
    expect(patUserRes.statusCode).toBe(201);
    const patUserId = JSON.parse(patUserRes.body).data.user.id;

    patient = await Patient.findOne({ userId: patUserId });
    if (!patient) {
      patient = await Patient.create({
        userId: patUserId,
        gender: "male",
        dob: new Date("1984-04-10"),
        organizationId: orgId,
      });
    }

    // 5. Setup Lab Test
    labTest = await LabTest.create({
      organizationId: orgId,
      clinicId,
      name: "Complete Blood Count (CBC)",
      department: "Hematology",
      code: "CBC-001",
      price: 450,
      sampleType: "Whole Blood",
      normalRange: "13.5 - 17.5 g/dL",
    });

    // 6. Setup Appointment with Clinical Details (Prescriptions & Lab Order)
    const appt: any = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id || patient.id,
      tokenNumber: 101,
      queuePosition: 1,
      appointmentTime: new Date(),
      appointmentType: "walk-in",
      status: "in-consultation",
      paymentStatus: "pending",
      paymentAmount: 750,
      diagnosis: "Acute Bronchitis & Viral Fever",
      prescriptions: [
        { name: "Amoxicillin 500mg", dosage: "1-0-1", duration: "5 days" },
        { name: "Paracetamol 650mg", dosage: "1-1-1", duration: "3 days" },
      ],
    });
    appointmentId = appt._id.toString();

    // Link a Lab Order to the Appointment
    await LabOrder.create({
      organizationId: orgId,
      clinicId,
      appointmentId: appt._id,
      patientId: patient._id || patient.id,
      doctorId,
      testId: labTest._id,
      status: "ordered",
    });
  });

  // ─── Test 1: Doctor OPD Session & Break Toggle synced with TV ─────────────
  it("should toggle doctor break on and off and reflect on public Queue TV feed", async () => {
    // 1. Start OPD Session
    const startRes = await app.inject({
      method: "POST",
      url: "/api/queue/session/start",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
      },
    });
    expect(startRes.statusCode).toBe(200);

    // 2. Doctor takes a break
    const breakRes = await app.inject({
      method: "POST",
      url: "/api/queue/session/break",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        isOnBreak: true,
        breakReason: "Medical Emergency Round",
        breakExpectedMinutes: 20,
      },
    });
    expect(breakRes.statusCode).toBe(200);
    const breakData = JSON.parse(breakRes.body).data;
    expect(breakData.isOnBreak).toBe(true);
    expect(breakData.breakReason).toBe("Medical Emergency Round");
    expect(breakData.breakExpectedMinutes).toBe(20);

    // 3. Verify public queue TV receives doctor break status
    const tvRes = await app.inject({
      method: "GET",
      url: `/api/public/queue-tv/${clinicId}?doctorId=${doctorId}`,
    });
    expect(tvRes.statusCode).toBe(200);
    const tvData = JSON.parse(tvRes.body).data;
    expect(tvData.doctorBreak).toBeDefined();
    expect(tvData.doctorBreak.isOnBreak).toBe(true);
    expect(tvData.doctorBreak.reason).toBe("Medical Emergency Round");
    expect(tvData.doctorBreak.expectedMinutes).toBe(20);

    // 4. Doctor resumes OPD
    const resumeRes = await app.inject({
      method: "POST",
      url: "/api/queue/session/break",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        isOnBreak: false,
      },
    });
    expect(resumeRes.statusCode).toBe(200);
    const resumedData = JSON.parse(resumeRes.body).data;
    expect(resumedData.isOnBreak).toBe(false);

    // 5. Verify TV reflects doctor resumed
    const tvResAfter = await app.inject({
      method: "GET",
      url: `/api/public/queue-tv/${clinicId}?doctorId=${doctorId}`,
    });
    const tvDataAfter = JSON.parse(tvResAfter.body).data;
    expect(tvDataAfter.doctorBreak.isOnBreak).toBe(false);
  });

  // ─── Test 2: Consolidated OPD Checkout Preview ───────────────────────────
  it("should compile doctor consultation, lab tests, and prescriptions in checkout preview", async () => {
    const previewRes = await app.inject({
      method: "GET",
      url: `/api/billing/checkout/preview/${appointmentId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(previewRes.statusCode).toBe(200);
    const preview = JSON.parse(previewRes.body).data;

    expect(preview.items).toBeDefined();
    expect(preview.items.length).toBeGreaterThanOrEqual(3); // Consult + Lab + at least 1 Rx

    const consultItem = preview.items.find((i: any) => i.category === "consultation");
    expect(consultItem).toBeDefined();
    expect(consultItem.amount).toBe(750);

    const labItem = preview.items.find((i: any) => i.category === "lab_test");
    expect(labItem).toBeDefined();
    expect(labItem.amount).toBe(450);

    const rxItems = preview.items.filter((i: any) => i.category === "pharmacy");
    expect(rxItems.length).toBeGreaterThanOrEqual(1);

    expect(preview.subtotal).toBeGreaterThanOrEqual(750 + 450);
    expect(preview.totalAmount).toBeGreaterThanOrEqual(preview.subtotal);
    expect(preview.isAlreadyPaid).toBe(false);
  });

  // ─── Test 3: Process Consolidated OPD Checkout ───────────────────────────
  it("should settle consolidated OPD checkout, create unified invoice, and update appointment to paid", async () => {
    const settleRes = await app.inject({
      method: "POST",
      url: "/api/billing/checkout/consolidate",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId,
        paymentMethod: "upi",
        discount: 50,
        notes: "Cashier settled combined OPD bill via Counter UPI QR",
      },
    });
    expect(settleRes.statusCode).toBe(200);
    const invoice = JSON.parse(settleRes.body).data;

    expect(invoice.invoiceNumber).toMatch(/^INV-/);
    expect(invoice.status).toBe("paid");
    expect(invoice.discount).toBe(50);
    expect(invoice.paymentMethod).toBe("upi");
    expect(invoice.items.length).toBeGreaterThanOrEqual(3);
    expect(invoice.payments.length).toBe(1);
    expect(invoice.payments[0].paymentMethod).toBe("upi");

    // Verify appointment was marked as paid and linked to invoice
    const updatedAppt = await Appointment.findById(appointmentId);
    expect(updatedAppt?.paymentStatus).toBe("paid");
    expect(updatedAppt?.invoiceId?.toString()).toBe(invoice.id || invoice._id);
  });
});

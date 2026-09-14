import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { Encounter } from "../models/Encounter.ts";

describe("Variable & Post-Consultation Doctor Fee Workflow Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let patientId: string;
  let appointmentId: string;
  let encounterId: string;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo PolyClinic ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Apollo Admin",
        admin_email: `apollo_admin_${Date.now()}@health.com`,
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
        name: "Apollo Andheri Specialty Clinic",
        city: "Mumbai",
        upiVpa: "apollo@hdfcbank",
        merchantName: "Apollo Clinics",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor with Post-Consultation Fee Type
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Seth",
        email: `vikram_${Date.now()}@apollo.com`,
        phone: `98${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: "Password123",
        specialization: "Senior Surgical Consultant",
        qualification: "MS, MCh",
        experience_years: 18,
        fees: 0,
        feeType: "post_consultation",
        clinicId,
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    // 4. Ensure DoctorAssignment has feeType: "post_consultation"
    await DoctorAssignment.findOneAndUpdate(
      { doctorId, clinicId },
      {
        fees: 0,
        feeType: "post_consultation",
        workingHours: JSON.stringify({
          Monday: ["09:00-18:00"],
          Tuesday: ["09:00-18:00"],
          Wednesday: ["09:00-18:00"],
          Thursday: ["09:00-18:00"],
          Friday: ["09:00-18:00"],
          Saturday: ["09:00-18:00"],
          Sunday: ["09:00-18:00"],
        }),
        bookingMode: "sequential_queue",
        isActive: true,
      },
      { upsert: true, new: true }
    );

    // 5. Create Patient
    const patientRes = await app.inject({
      method: "POST",
      url: "/api/patients",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Aakash Mehta",
        phone: `91${Math.floor(10000000 + Math.random() * 90000000)}`,
        gender: "male",
        dob: "1988-04-12",
        clinicId,
      },
    });
    expect(patientRes.statusCode).toBe(201);
    patientId = JSON.parse(patientRes.body).data.id;
  });

  it("1. Public clinic details API reflects feeType: 'post_consultation'", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/public/clinics/${clinicId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const doctor = body.data.doctors.find((d: any) => d.id === doctorId);
    expect(doctor).toBeDefined();
    expect(doctor.feeType).toBe("post_consultation");
  });

  it("2. Books appointment with paymentStatus: 'pay_at_clinic' and skips upfront invoice creation", async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(10, 0, 0, 0);

    const bookingRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        patientId,
        appointmentTime: tomorrow.toISOString(),
        appointmentType: "online",
        notes: "Pre-operative evaluation",
      },
    });

    expect(bookingRes.statusCode).toBe(201);
    const apptData = JSON.parse(bookingRes.body).data;
    appointmentId = apptData.id;

    const savedAppt = await Appointment.findById(appointmentId);
    expect(savedAppt).toBeDefined();
    expect(savedAppt?.feeType).toBe("post_consultation");
    expect(savedAppt?.paymentStatus).toBe("pay_at_clinic");

    // Must NOT have generated an upfront fixed invoice
    const apptInvoice = await Invoice.findOne({ appointmentId });
    expect(apptInvoice).toBeNull();
  });

  it("3. Compiles encounter charges preview and allows doctor to specify custom consultation fee", async () => {
    // Create Encounter
    const enc = await Encounter.create({
      organizationId: orgId,
      clinicId,
      appointmentId,
      patientId,
      doctorId,
      encounterType: "opd",
      status: "in_progress",
    });
    encounterId = enc._id.toString();

    // Preview without custom fee — isFeeEditable must be true
    const previewRes1 = await app.inject({
      method: "GET",
      url: `/api/encounters/${encounterId}/charges-preview`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(previewRes1.statusCode).toBe(200);
    const preview1 = JSON.parse(previewRes1.body).data;
    expect(preview1.isFeeEditable).toBe(true);
    expect(preview1.feeType).toBe("post_consultation");

    // Preview with doctor's custom fee of ₹850
    const previewRes2 = await app.inject({
      method: "GET",
      url: `/api/encounters/${encounterId}/charges-preview?customConsultFee=850`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(previewRes2.statusCode).toBe(200);
    const preview2 = JSON.parse(previewRes2.body).data;
    expect(preview2.subtotal).toBe(850);
    expect(preview2.totalAmount).toBe(850);
    const consultItem = preview2.items.find((i: any) => i.category === "consultation");
    expect(consultItem).toBeDefined();
    expect(consultItem.amount).toBe(850);
  });

  it("4. Doctor generates official invoice from encounter with custom fee of ₹850", async () => {
    const invRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/auto-invoice`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        customConsultFee: 850,
      },
    });

    expect(invRes.statusCode).toBe(201);
    const invoice = JSON.parse(invRes.body).data;
    expect(invoice.totalAmount).toBe(850);
    expect(invoice.status).toBe("unpaid");

    const consultLine = invoice.items.find((it: any) => it.description.includes("Physician Consultation"));
    expect(consultLine).toBeDefined();
    expect(consultLine.amount).toBe(850);

    // Verifies appointment customConsultationFee was updated
    const updatedAppt = await Appointment.findById(appointmentId);
    expect(updatedAppt?.customConsultationFee).toBe(850);
  });

  it("5. Receptionist performs consolidated checkout with fee adjustments and cash settlement", async () => {
    // Book a second appointment to test reception checkout flow
    const appt2Res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        patientId,
        appointmentTime: new Date(Date.now() + 7200000).toISOString(),
        appointmentType: "walk-in",
        notes: "Walk-in consultation",
      },
    });
    expect(appt2Res.statusCode).toBe(201);
    const appt2Id = JSON.parse(appt2Res.body).data.id;

    // Checkout preview
    const checkoutPreviewRes = await app.inject({
      method: "GET",
      url: `/api/billing/checkout/preview/${appt2Id}?customConsultFee=600`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(checkoutPreviewRes.statusCode).toBe(200);
    const checkoutPreview = JSON.parse(checkoutPreviewRes.body).data;
    expect(checkoutPreview.feeType).toBe("post_consultation");
    expect(checkoutPreview.isFeeEditable).toBe(true);
    expect(checkoutPreview.totalAmount).toBe(600);

    // Consolidated checkout execution
    const checkoutRes = await app.inject({
      method: "POST",
      url: "/api/billing/checkout/consolidate",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: appt2Id,
        paymentMethod: "cash",
        customConsultationFee: 600,
        amountPaid: 600,
        notes: "Settled in cash at reception",
      },
    });

    expect(checkoutRes.statusCode).toBe(200);
    const checkoutResult = JSON.parse(checkoutRes.body).data;
    expect(checkoutResult.status).toBe("paid");
    expect(checkoutResult.totalAmount).toBe(600);

    const settledAppt = await Appointment.findById(appt2Id);
    expect(settledAppt?.paymentStatus).toBe("paid");
    expect(settledAppt?.customConsultationFee).toBe(600);
  });
});

import crypto from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Appointment } from "../models/Appointment.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { Invoice } from "../models/Invoice.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { generateAccessToken } from "../utilities/helpers.ts";

function testPaymentSignature(orderId: string, paymentId: string): string {
  return crypto.createHmac("sha256", "test_secret").update(`${orderId}|${paymentId}`).digest("hex");
}

describe("Clinic Essentials Cycle 3 — Patient Self Check-In", () => {
  let patientToken: string;
  let appointmentId: string;

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `CheckIn Org ${Date.now()}`,
        city: "Mumbai",
        admin_name: "CheckIn Admin",
        admin_email: `checkin-admin-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const adminCookies = (orgRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);

    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "CheckIn Clinic", city: "Mumbai" },
    });
    const clinicId = JSON.parse(clinicRes.body).data.id;

    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr CheckIn",
        email: `dr-checkin-${Date.now()}@test.com`,
        password: "Password123!",
        specialization: "General",
      },
    });
    const doctorId = JSON.parse(docRes.body).data.id;

    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: { doctorId, clinicId, fees: 200, workingHours: "09:00 - 17:00" },
    });

    const orgId = JSON.parse(orgRes.body).data.organization.id;

    const patientEmail = `checkin-patient-${Date.now()}@test.com`;
    const patientUser = await User.create({
      name: "CheckIn Patient",
      email: patientEmail,
      password: "hashed",
      role: "patient",
    });
    const patient = await Patient.create({
      userId: patientUser._id,
      name: "CheckIn Patient",
      email: patientEmail,
      phone: `9222${Date.now().toString().slice(-6)}`,
      organizationId: orgId,
      accountType: "self",
      dob: new Date("1992-03-10"),
      gender: "male",
    });
    await OrgMember.create({ userId: patientUser._id, organizationId: orgId, role: "patient" });

    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        patientId: patient.id,
        appointmentTime: new Date().toISOString(),
        appointmentType: "walk-in",
      },
    });
    expect(apptRes.statusCode).toBe(201);
    appointmentId = JSON.parse(apptRes.body).data.id;

    patientToken = generateAccessToken({
      id: patientUser.id,
      email: patientEmail,
      role: "patient",
      organization_id: orgId,
    });
  });

  it("should allow patient to self check-in without MANAGE_QUEUE permission", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/appointments/${appointmentId}/check-in`,
      headers: { authorization: `Bearer ${patientToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.status).toBe("checked-in");
  });
});

describe("Clinic Essentials Cycle 3 — clinic_manager Desk Workflows", () => {
  let managerCookies: string[];
  let clinicId: string;

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `CM Desk Org ${Date.now()}`,
        city: "Delhi",
        admin_name: "CM Desk Admin",
        admin_email: `cm-desk-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const adminCookies = (orgRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);

    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "CM Desk Clinic", city: "Delhi" },
    });
    clinicId = JSON.parse(clinicRes.body).data.id;

    const managerEmail = `cm-desk-mgr-${Date.now()}@test.com`;
    await app.inject({
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

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: managerEmail, password: "Password123!" },
    });
    managerCookies = (loginRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
  });

  it("should allow clinic_manager to register a walk-in patient", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/patients",
      headers: { cookie: managerCookies.join("; ") },
      payload: {
        name: "Walk-in CM Patient",
        phone: `9333${Date.now().toString().slice(-6)}`,
        dob: "1988-07-20",
        gender: "female",
        ignoreDuplicate: true,
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("should allow clinic_manager to create medicines", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/medicines",
      headers: { cookie: managerCookies.join("; ") },
      payload: {
        clinicId,
        name: "CM Test Medicine",
        genericName: "TestGeneric",
        stockQuantity: 50,
        price: 10,
        costPrice: 5,
        expiryDate: new Date(Date.now() + 365 * 86400000).toISOString(),
        batchNumber: `BATCH-CM-${Date.now()}`,
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("Clinic Essentials Cycle 3 — Payment Verify IDOR", () => {
  let userAToken: string;
  let victimAppointmentId: string;
  let orderId: string;
  let paymentId: string;
  let signature: string;

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Pay IDOR Org ${Date.now()}`,
        city: "Chennai",
        admin_name: "Pay Admin",
        admin_email: `pay-idor-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const orgId = JSON.parse(orgRes.body).data.organization.id;
    const adminCookies = (orgRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);

    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Pay Clinic", city: "Chennai" },
    });
    const clinicId = JSON.parse(clinicRes.body).data.id;

    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr Pay",
        email: `dr-pay-${Date.now()}@test.com`,
        password: "Password123!",
        specialization: "General",
      },
    });
    const doctorId = JSON.parse(docRes.body).data.id;

    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: { doctorId, clinicId, fees: 500, workingHours: "09:00 - 17:00" },
    });

    const patientAEmail = `pay-patient-a-${Date.now()}@test.com`;
    const apptARes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "online",
        patientDetails: {
          name: "Pay Patient A",
          dob: "1990-01-01",
          gender: "male",
          phone: `9444${Date.now().toString().slice(-6)}`,
          email: patientAEmail,
          password: "Password123!",
        },
      },
    });
    expect(apptARes.statusCode).toBe(201);
    const apptAId = JSON.parse(apptARes.body).data.id;
    const patientAId = JSON.parse(apptARes.body).data.patientId;

    const apptBRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        appointmentTime: new Date(Date.now() + 3600000).toISOString(),
        appointmentType: "online",
        patientDetails: {
          name: "Pay Patient B",
          dob: "1991-02-02",
          gender: "female",
          phone: `9555${Date.now().toString().slice(-6)}`,
          email: `pay-patient-b-${Date.now()}@test.com`,
          password: "Password123!",
        },
      },
    });
    expect(apptBRes.statusCode).toBe(201);
    victimAppointmentId = JSON.parse(apptBRes.body).data.id;

    orderId = `order_idor_${Date.now()}`;
    paymentId = `pay_idor_${Date.now()}`;
    signature = testPaymentSignature(orderId, paymentId);

    await AppointmentPayment.create({
      appointmentId: apptAId,
      patientId: patientAId,
      amount: 500,
      currency: "INR",
      paymentMethod: "razorpay",
      razorpayOrderId: orderId,
      status: "created",
      idempotencyKey: `pay_order_${apptAId}_500`,
    });

    await Invoice.create({
      invoiceNumber: `INV-2026-IDOR-${Date.now()}`,
      organizationId: orgId,
      patientId: patientAId,
      appointmentId: apptAId,
      clinicId,
      doctorId,
      items: [{ description: "Consultation Fee", amount: 500, quantity: 1 }],
      subtotal: 500,
      totalAmount: 500,
      status: "unpaid",
    });

    const apptA = await Appointment.findById(apptAId);
    userAToken = generateAccessToken({
      id: apptA!.bookedByUserId!.toString(),
      email: patientAEmail,
      role: "patient",
      organization_id: orgId,
    });
  });

  it("should reject verify when appointmentId does not match payment record", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/verify",
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
        appointmentId: victimAppointmentId,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain("does not match");
  });

  it("should mark only the payment-record appointment as paid on valid verify", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/verify",
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature,
      },
    });
    expect(res.statusCode).toBe(200);

    const victimAppt = await Appointment.findById(victimAppointmentId);
    expect(victimAppt?.paymentStatus).not.toBe("paid");
  });
});

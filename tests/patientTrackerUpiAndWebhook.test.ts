import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { sendPaymentReceiptNotification } from "../utilities/notifications.ts";

describe("Patient Mobile Tracker 1-Tap UPI, Inbound Webhook & Digital Receipts Test Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let patient: any;

  beforeAll(async () => {
    // 1. Setup Organization & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Max Healthcare Group ${Date.now()}`,
        city: "Delhi",
        admin_name: "Max Super Admin",
        admin_email: `max_admin_${Date.now()}@maxhealthcare.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // 2. Setup Clinic with custom Multi-Tenant UPI VPA
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Max Saket Super Specialty",
        city: "New Delhi",
        upiVpa: "max.saket@icici",
        merchantName: "Max Saket Healthcare Ltd",
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
        name: "Dr. Rajesh Gulati",
        email: `dr_rajesh_${Date.now()}@maxhealthcare.com`,
        password: "Password123",
        phone: "+919811223344",
        specialization: "Cardiology",
        medicalCouncilRegNumber: `MCI-${Date.now()}`,
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    await DoctorAssignment.create({
      organizationId: orgId,
      doctorId,
      clinicId,
      fees: 700,
      workingHours: "[]",
      isActive: true,
    });

    // 4. Setup Patient
    const patUserRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Sunil Verma",
        email: `sunil_${Date.now()}@verma.com`,
        password: "Password123",
        phone: "+919822334455",
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
        dob: new Date("1980-08-20"),
        organizationId: orgId,
      });
    }
    expect(patient).toBeDefined();
  });

  it("Pillar 1: Public live tracker returns clinic's custom upiVpa and merchantName", async () => {
    const appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date().toISOString(),
      appointmentType: "walk-in",
      status: "in-consultation",
      tokenNumber: 51,
      queuePosition: 1,
      paymentStatus: "unpaid",
      paymentAmount: 700,
    });

    const trackerRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appt._id}`,
    });

    expect(trackerRes.statusCode).toBe(200);
    const body = JSON.parse(trackerRes.body);
    expect(body.success).toBe(true);
    expect(body.data.clinic).toBeDefined();
    expect(body.data.clinic.upiVpa).toBe("max.saket@icici");
    expect(body.data.clinic.merchantName).toBe("Max Saket Healthcare Ltd");
  });

  it("Pillar 2: Patient self-service payment on live tracker settles bill and marks appointment paid", async () => {
    const appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date().toISOString(),
      appointmentType: "walk-in",
      status: "completed",
      tokenNumber: 52,
      queuePosition: 2,
      paymentStatus: "unpaid",
      paymentAmount: 850,
    });

    const invoice = await Invoice.create({
      organizationId: orgId,
      clinicId,
      patientId: patient._id,
      doctorId,
      appointmentId: appt._id,
      invoiceNumber: `INV-TEST-${Date.now().toString().slice(-6)}`,
      dueDate: new Date(),
      subtotal: 850,
      totalAmount: 850,
      amountPaid: 0,
      balanceDue: 850,
      status: "unpaid",
      items: [
        {
          description: "Consultation + ECG Cardio Diagnostic",
          quantity: 1,
          amount: 850,
          totalItemAmount: 850,
        },
      ],
    });

    // Patient clicks "Confirm & Pay" on Mobile Live Tracker
    const payRes = await app.inject({
      method: "POST",
      url: `/api/public/track/${appt._id}/pay`,
      payload: { paymentMethod: "upi" },
    });

    expect(payRes.statusCode).toBe(200);
    const body = JSON.parse(payRes.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("paid");
    expect(body.data.balanceDue).toBe(0);

    // Verify DB update
    const settledAppt = await Appointment.findById(appt._id);
    expect(settledAppt?.paymentStatus).toBe("paid");

    const settledInv = await Invoice.findById(invoice._id);
    expect(settledInv?.status).toBe("paid");
    expect(settledInv?.amountPaid).toBe(850);
    expect(settledInv?.balanceDue).toBe(0);
    expect(settledInv?.paymentMethod).toBe("upi");
  });

  it("Pillar 3: Autonomous inbound UPI bank webhook (/api/webhooks/upi) processes zero-touch settlement", async () => {
    const apptWeb = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date().toISOString(),
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 53,
      queuePosition: 3,
      paymentStatus: "unpaid",
      paymentAmount: 600,
    });

    const txnId = `NPCI-UPI-${Date.now()}`;
    const webhookRes = await app.inject({
      method: "POST",
      url: "/api/webhooks/upi",
      payload: {
        transactionId: txnId,
        appointmentId: apptWeb._id.toString(),
        amount: 600,
        status: "SUCCESS",
        paymentMethod: "upi",
        payerVpa: "sunil.verma@okhdfcbank",
      },
    });

    expect(webhookRes.statusCode).toBe(200);
    const body = JSON.parse(webhookRes.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("settled");
    expect(body.data.transactionId).toBe(txnId);

    // Verify DB integrity
    const verifiedAppt = await Appointment.findById(apptWeb._id);
    expect(verifiedAppt?.paymentStatus).toBe("paid");
    expect(verifiedAppt?.paymentAmount).toBe(600);

    const verifiedInvoice = await Invoice.findOne({ appointmentId: apptWeb._id });
    expect(verifiedInvoice).toBeDefined();
    expect(verifiedInvoice?.status).toBe("paid");
    expect(verifiedInvoice?.amountPaid).toBe(600);
    expect(verifiedInvoice?.balanceDue).toBe(0);
    expect(verifiedInvoice?.payments?.[0]?.referenceNumber).toBe(txnId);

    const paymentRecord = await AppointmentPayment.findOne({ appointmentId: apptWeb._id });
    expect(paymentRecord).toBeDefined();
    expect(paymentRecord?.status).toBe("captured");
    expect(paymentRecord?.amount).toBe(600);
  });

  it("Pillar 4: Digital Receipt dispatch helper executes cleanly", async () => {
    const appt = await Appointment.findOne({ clinicId });
    expect(appt).toBeDefined();

    // Verify calling sendPaymentReceiptNotification directly doesn't throw
    await expect(
      sendPaymentReceiptNotification({
        appointmentId: appt!._id.toString(),
        amount: 500,
        paymentMethod: "upi",
      })
    ).resolves.not.toThrow();
  });
});

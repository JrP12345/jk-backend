import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { CashierShift } from "../models/CashierShift.ts";

describe("Autonomous Follow-Up Scheduling, Public Tracker Sync & Cashier Till Reconciliation Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let doctorUserId: string;
  let patient: any;
  let appointmentId: string;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Clinical Health ${Date.now()}`,
        city: "Hyderabad",
        admin_name: "Apollo Medical Director",
        admin_email: `apollo_admin_${Date.now()}@apollo.com`,
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
        name: "Apollo Jubilee Hills Health Center",
        city: "Hyderabad",
        upiVpa: "apollo.reception@icici",
        merchantName: "Apollo Clinics Ltd",
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
        name: "Dr. K. Srinivas",
        email: `dr_srinivas_${Date.now()}@apollo.com`,
        password: "Password123",
        specialization: "Cardiology",
        qualification: "MBBS, DM Cardiology",
        experience: 18,
        consultationFee: 800,
        contactNumber: "+919876543299",
      },
    });
    expect(docRes.statusCode).toBe(201);
    const docData = JSON.parse(docRes.body).data;
    doctorId = docData.id;
    doctorUserId = docData.userId || docData.id;

    await DoctorAssignment.create({
      organizationId: orgId,
      doctorId,
      clinicId,
      fees: 800,
      workingHours: "[]",
      isActive: true,
    });

    // 4. Setup Patient
    const patUserRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Arjun Reddy",
        email: `arjun_${Date.now()}@gmail.com`,
        password: "Password123",
        phone: "+919888776655",
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
        dob: new Date("1992-04-10"),
        organizationId: orgId,
      });
    }

    // 5. Create active In-Consultation Appointment
    const appt = await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date().toISOString(),
      appointmentType: "walk-in",
      status: "in-consultation",
      tokenNumber: 15,
      queuePosition: 1,
      paymentStatus: "paid",
      paymentAmount: 800,
      notes: "Routine cardiac checkup and blood pressure management",
    });
    appointmentId = appt._id.toString();
  });

  it("1. Concluding consultation with followUpRecommended automatically books next appointment with confirmed token", async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const futureDateStr = futureDate.toISOString();

    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/appointments/${appointmentId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "completed",
        symptoms: "Occasional palpitations and mild exertional fatigue",
        diagnosis: "Stage 1 Essential Hypertension",
        prescriptions: [
          {
            name: "Telmisartan 40mg",
            dosage: "1 tablet once daily in the morning",
            duration: "30 days",
            frequency: "1-0-0",
            instructions: "Take after breakfast with water",
          },
        ],
        followUpRecommended: true,
        followUpTimeline: "1 week",
        followUpNotes: "Review BP response to Telmisartan",
        followUpDate: futureDateStr,
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updatedBody = JSON.parse(updateRes.body);
    expect(updatedBody.success).toBe(true);

    // Verify original appointment has followUpAppointmentId recorded
    const originalAppt = await Appointment.findById(appointmentId);
    expect(originalAppt).toBeDefined();
    expect(originalAppt?.status).toBe("completed");
    expect(originalAppt?.followUpAppointmentId).toBeDefined();

    // Verify auto-created confirmed follow-up appointment in MongoDB
    const followUpAppt = await Appointment.findById(originalAppt?.followUpAppointmentId);
    expect(followUpAppt).toBeDefined();
    expect(followUpAppt?.status).toBe("confirmed");
    expect(followUpAppt?.patientId.toString()).toBe(patient._id.toString());
    expect(followUpAppt?.doctorId.toString()).toBe(doctorId.toString());
    expect(followUpAppt?.clinicId.toString()).toBe(clinicId.toString());
    expect(followUpAppt?.tokenNumber).toBeGreaterThan(0);
    expect(followUpAppt?.notes).toContain("Review BP response to Telmisartan");
  });

  it("2. Patient public tracker synchronizes confirmed follow-up consultation and token", async () => {
    const trackerRes = await app.inject({
      method: "GET",
      url: `/api/public/tracker/${appointmentId}`,
    });

    expect(trackerRes.statusCode).toBe(200);
    const trackerData = JSON.parse(trackerRes.body).data;
    expect(trackerData).toBeDefined();
    expect(trackerData.status).toBe("completed");

    // Must return synchronized follow-up appointment
    expect(trackerData.followUpAppointment).toBeDefined();
    expect(trackerData.followUpAppointment.id).toBeDefined();
    expect(trackerData.followUpAppointment.tokenNumber).toBeGreaterThan(0);
    expect(trackerData.followUpAppointment.status).toBe("confirmed");
  });

  it("3. Cashier Till Ledger computes accurate system collections for cash, UPI, and card receipts", async () => {
    const today = new Date();

    // Seed 3 paid invoices with distinct collection channels
    await Invoice.create({
      organizationId: orgId,
      clinicId,
      patientId: patient._id,
      doctorId,
      invoiceNumber: `INV-CASH-${Date.now()}`,
      items: [{ description: "Consultation", amount: 1500, quantity: 1 }],
      subtotal: 1500,
      tax: 0,
      discount: 0,
      totalAmount: 1500,
      amountPaid: 1500,
      balanceDue: 0,
      status: "paid",
      paymentMethod: "cash",
      paymentDate: today,
    });

    await Invoice.create({
      organizationId: orgId,
      clinicId,
      patientId: patient._id,
      doctorId,
      invoiceNumber: `INV-UPI-${Date.now()}`,
      items: [{ description: "Cardiology ECG & Echo", amount: 2400, quantity: 1 }],
      subtotal: 2400,
      tax: 0,
      discount: 0,
      totalAmount: 2400,
      amountPaid: 2400,
      balanceDue: 0,
      status: "paid",
      paymentMethod: "upi",
      paymentDate: today,
    });

    await Invoice.create({
      organizationId: orgId,
      clinicId,
      patientId: patient._id,
      doctorId,
      invoiceNumber: `INV-CARD-${Date.now()}`,
      items: [{ description: "Pharmacy Package", amount: 1100, quantity: 1 }],
      subtotal: 1100,
      tax: 0,
      discount: 0,
      totalAmount: 1100,
      amountPaid: 1100,
      balanceDue: 0,
      status: "paid",
      paymentMethod: "card",
      paymentDate: today,
    });

    const summaryRes = await app.inject({
      method: "GET",
      url: `/api/billing/till/summary?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(summaryRes.statusCode).toBe(200);
    const summaryData = JSON.parse(summaryRes.body).data;
    expect(summaryData.clinicId).toBe(clinicId);
    expect(summaryData.systemTotals).toBeDefined();
    expect(summaryData.systemTotals.cash).toBe(1500);
    expect(summaryData.systemTotals.upi).toBe(2400);
    expect(summaryData.systemTotals.card).toBe(1100);
    expect(summaryData.systemTotals.total).toBe(5000);
    expect(summaryData.systemTotals.invoiceCount).toBe(3);
  });

  it("4. Front-desk cashier reconciles cash drawer and executes shift closeout with audit trail", async () => {
    // Cash drawer physical count has ₹1,550 (₹50 surplus)
    const closeRes = await app.inject({
      method: "POST",
      url: "/api/billing/till/close",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        actualCashCounted: 1550,
        varianceReason: "Petty change surplus in reception cash box",
        handoverNotes: "Counted by Day Shift Cashier. Drawer keys handed to Evening Shift Supervisor.",
      },
    });

    expect(closeRes.statusCode).toBe(201);
    const closeBody = JSON.parse(closeRes.body);
    expect(closeBody.success).toBe(true);

    const shiftData = closeBody.data;
    expect(shiftData).toBeDefined();
    expect(shiftData.clinicId).toBe(clinicId);
    expect(shiftData.actualCashCounted).toBe(1550);
    expect(shiftData.systemTotals.cash).toBe(1500);
    expect(shiftData.cashVariance).toBe(50);
    expect(shiftData.varianceReason).toBe("Petty change surplus in reception cash box");
    expect(shiftData.status).toBe("closed");

    // Subsequent till summary call reflects the closed shift as latestShift
    const updatedSummaryRes = await app.inject({
      method: "GET",
      url: `/api/billing/till/summary?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(updatedSummaryRes.statusCode).toBe(200);
    const updatedSummary = JSON.parse(updatedSummaryRes.body).data;
    expect(updatedSummary.latestShift).toBeDefined();
    const createdId = String(shiftData.id || shiftData._id);
    const retrievedId = String(updatedSummary.latestShift._id || updatedSummary.latestShift.id);
    expect(retrievedId).toBe(createdId);
    expect(updatedSummary.latestShift.cashVariance).toBe(50);
  });

  it("5. Till closeout enforces validation for counted cash amounts", async () => {
    const invalidRes = await app.inject({
      method: "POST",
      url: "/api/billing/till/close",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        actualCashCounted: -250,
      },
    });

    expect(invalidRes.statusCode).toBe(400);
    const errBody = JSON.parse(invalidRes.body);
    expect(errBody.success).toBe(false);
    expect(errBody.message).toContain("non-negative number");
  });
});

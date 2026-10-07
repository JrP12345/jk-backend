import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { User } from "../models/User.ts";
import { fixtureAccessToken } from "./helpers/sessionFixture.ts";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";

describe("Counter-Top Dynamic UPI VPA, Itemized Billing & Soundbox Settlement Test Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let locationId: string;
  let doctorId: string;
  let patient: any;

  beforeAll(async () => {
    // 1. Setup Organization & Root/Location Admin
    const bootstrapRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Multi-Tenant Healthcare ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Apollo Ops Admin",
        admin_email: `apollo_admin_${Date.now()}@apolloops.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (await provisionedAdminCookies(bootstrapRes));
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // 2. Setup Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Ananya Roy",
        email: `dr_ananya_${Date.now()}@apolloops.com`,
        password: "Password123",
        phone: "+919876543210",
        specialization: "General Physician",
        medicalCouncilRegNumber: `MCI-${Date.now()}`,
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    // 3. Register Patient Profile
    const patUserRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Suresh Kumar",
        email: `suresh_${Date.now()}@gmail.com`,
        password: "Password123",
        phone: "+919811122233",
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
        dob: new Date("1985-05-12"),
        organizationId: orgId,
      });
    }
    expect(patient).toBeDefined();
  });

  it("Pillar 1: Clinic creation & update persists custom multi-tenant upiVpa and merchantName", async () => {
    // Create Location with custom UPI VPA
    const locationRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/locations",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Apollo South Mumbai Clinic",
        city: "Mumbai",
        upiVpa: "apollo.southmumbai@icici",
        merchantName: "Apollo South Mumbai Clinic Ltd",
      },
    });
    expect(locationRes.statusCode).toBe(201);
    locationId = JSON.parse(locationRes.body).data.id;

    const locationInDb = await Location.findById(locationId);
    expect(locationInDb).toBeDefined();
    expect(locationInDb?.upiVpa).toBe("apollo.southmumbai@icici");
    expect(locationInDb?.merchantName).toBe("Apollo South Mumbai Clinic Ltd");

    // Assign doctor to this location
    await DoctorAssignment.create({
      organizationId: orgId,
      doctorId,
      locationId,
      fees: 500,
      workingHours: "[]",
      isActive: true,
    });

    // Update Location UPI VPA via PUT /api/onboarding/locations/:id
    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/onboarding/locations/${locationId}`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Apollo South Mumbai Clinic",
        city: "Mumbai",
        upiVpa: "apollo.mumbai.counter@okhdfcbank",
        merchantName: "Apollo Health Care Mumbai",
      },
    });
    expect(updateRes.statusCode).toBe(200);

    const updatedLocation = await Location.findById(locationId);
    expect(updatedLocation?.upiVpa).toBe("apollo.mumbai.counter@okhdfcbank");
    expect(updatedLocation?.merchantName).toBe("Apollo Health Care Mumbai");
  });

  it("Pillar 2: Counter-top settlement accepts consolidated bill amount (Consultation + Diagnostics)", async () => {
    // Book an appointment for Suresh Kumar
    const appt = await Appointment.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date().toISOString(),
      appointmentType: "walk-in",
      status: "in-consultation",
      tokenNumber: 42,
      queuePosition: 1,
      paymentStatus: "unpaid",
      paymentAmount: 500,
    });

    // Consolidated bill: Consultation (₹500) + CBC (₹350) + RBS (₹150) = ₹1000
    const consolidatedTotal = 1000;

    // The invoice is the authoritative source for a consolidated charge. The
    // browser must not be able to choose the collected amount.
    await Invoice.create({
      invoiceNumber: `DYN-UPI-${Date.now()}`,
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient._id,
      appointmentId: appt._id,
      items: [
        { description: "Consultation", amount: 500, quantity: 1 },
        { description: "CBC", amount: 350, quantity: 1 },
        { description: "RBS", amount: 150, quantity: 1 },
      ],
      subtotal: consolidatedTotal,
      totalAmount: consolidatedTotal,
      amountPaid: 0,
      balanceDue: consolidatedTotal,
      status: "unpaid",
    });

    const payRes = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/collect-counter",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: appt._id.toString(),
        paymentMethod: "upi",
        amount: 1, // Deliberately tampered client value; it must be ignored.
      },
    });

    expect(payRes.statusCode).toBe(200);
    const body = JSON.parse(payRes.body);
    expect(body.success).toBe(true);
    expect(body.data.appointment.paymentStatus).toBe("paid");
    expect(body.data.appointment.paymentAmount).toBe(consolidatedTotal);

    // Verify DB integrity: Appointment
    const settledAppt = await Appointment.findById(appt._id);
    expect(settledAppt?.paymentStatus).toBe("paid");
    expect(settledAppt?.paymentAmount).toBe(consolidatedTotal);

    // Verify DB integrity: Invoice
    const invoice = await Invoice.findOne({ appointmentId: appt._id });
    expect(invoice).toBeDefined();
    expect(invoice?.status).toBe("paid");
    expect(invoice?.totalAmount).toBe(consolidatedTotal);
    expect(invoice?.amountPaid).toBe(consolidatedTotal);
    expect(invoice?.balanceDue).toBe(0);
    expect(invoice?.paymentMethod).toBe("upi");

    // Verify DB integrity: AppointmentPayment capture record
    const paymentRecord = await AppointmentPayment.findOne({ appointmentId: appt._id });
    expect(paymentRecord).toBeDefined();
    expect(paymentRecord?.amount).toBe(consolidatedTotal);
    expect(paymentRecord?.status).toBe("captured");
    expect(paymentRecord?.paymentMethod).toBe("upi");
  });

  it("Pillar 3: Cash & Card settlement flows support flexible counter-top payments", async () => {
    // Book second appointment for Cash settlement
    const apptCash = await Appointment.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient._id,
      appointmentTime: new Date().toISOString(),
      appointmentType: "walk-in",
      status: "checked-in",
      tokenNumber: 43,
      queuePosition: 2,
      paymentStatus: "unpaid",
      paymentAmount: 500,
    });

    const cashRes = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/collect-counter",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        appointmentId: apptCash._id.toString(),
        paymentMethod: "cash",
        amount: 500,
      },
    });

    expect(cashRes.statusCode).toBe(200);
    const cashBody = JSON.parse(cashRes.body);
    expect(cashBody.data.appointment.paymentStatus).toBe("paid");

    const settledCashAppt = await Appointment.findById(apptCash._id);
    expect(settledCashAppt?.paymentStatus).toBe("paid");

    const cashInvoice = await Invoice.findOne({ appointmentId: apptCash._id });
    expect(cashInvoice?.paymentMethod).toBe("cash");
    expect(cashInvoice?.status).toBe("paid");

    const guest = await User.create({ name: "Restricted guest", role: "patient" });
    const guestToken = (await fixtureAccessToken({
      id: guest.id,
      email: "guest@example.test",
      role: "guest",
      organization_id: orgId,
    }));
    const guestRes = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/collect-counter",
      headers: { cookie: `access_token=${guestToken}` },
      payload: { appointmentId: apptCash._id.toString(), paymentMethod: "cash" },
    });
    expect(guestRes.statusCode).toBe(403);
  });

  it("requires authentication for the reception check-in route", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/check-in/qr",
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});

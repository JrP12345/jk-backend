import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { reuseOnboardingLocation } from "./helpers/locationEssentialsSetup.ts";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import { Invoice } from "../models/Invoice.ts";

describe("Clinic Essentials Cycle 4 — Payment Tenant Isolation", () => {
  let orgACookies: string[];
  let orgBCookies: string[];
  let foreignAppointmentId: string;

  beforeAll(async () => {
    await app.ready();

    const orgARes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Pay Tenant A ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Pay A Admin",
        admin_email: `pay-tenant-a-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    orgACookies = (await provisionedAdminCookies(orgARes));

    const locationARes = await reuseOnboardingLocation(app, { headers: { cookie: orgACookies.join("; ") }, payload: { name: "Pay Clinic A", city: "Mumbai" } });
    const locationAId = JSON.parse(locationARes.body).data.id;

    const docARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: orgACookies.join("; ") },
      payload: {
        name: "Dr Pay A",
        email: `dr-pay-a-${Date.now()}@test.com`,
        password: "Password123!",
        specialization: "General",
      },
    });
    const docAId = JSON.parse(docARes.body).data.id;

    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: orgACookies.join("; ") },
      payload: { doctorId: docAId, locationId: locationAId, fees: 300, workingHours: "00:00 - 23:59" },
    });

    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: orgACookies.join("; ") },
      payload: {
        locationId: locationAId,
        doctorId: docAId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "walk-in",
        patientDetails: {
          name: "Foreign Pay Patient",
          dob: "1990-01-01",
          gender: "male",
          phone: `9666${Date.now().toString().slice(-6)}`,
          email: `foreign-pay-${Date.now()}@test.com`,
        },
      },
    });
    expect(apptRes.statusCode).toBe(201);
    foreignAppointmentId = JSON.parse(apptRes.body).data.id;

    const orgBRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Pay Tenant B ${Date.now()}`,
        city: "Delhi",
        admin_name: "Pay B Admin",
        admin_email: `pay-tenant-b-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    orgBCookies = (await provisionedAdminCookies(orgBRes));
  });

  it("should block cross-tenant staff from creating payment orders", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointment-payments/create-order",
      headers: { cookie: orgBCookies.join("; ") },
      payload: { appointmentId: foreignAppointmentId },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("Clinic Essentials Cycle 4 — location_manager Billing", () => {
  let managerCookies: string[];
  let locationId: string;
  let doctorId: string;
  let patientId: string;

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `CM Billing Org ${Date.now()}`,
        city: "Pune",
        admin_name: "CM Bill Admin",
        admin_email: `cm-bill-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    const adminCookies = (await provisionedAdminCookies(orgRes));

    const locationRes = await reuseOnboardingLocation(app, { headers: { cookie: adminCookies.join("; ") }, payload: { name: "CM Bill Clinic", city: "Pune" } });
    locationId = JSON.parse(locationRes.body).data.id;

    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr CM Bill",
        email: `dr-cm-bill-${Date.now()}@test.com`,
        password: "Password123!",
        specialization: "General",
      },
    });
    doctorId = JSON.parse(docRes.body).data.id;

    const managerEmail = `cm-bill-mgr-${Date.now()}@test.com`;
    await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Billing Manager",
        email: managerEmail,
        password: "Password123!",
        role: "location_manager",
      },
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: managerEmail, password: "Password123!" },
    });
    managerCookies = (loginRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);

    const patientRes = await app.inject({
      method: "POST",
      url: "/api/patients",
      headers: { cookie: managerCookies.join("; ") },
      payload: {
        name: "Bill Target Patient",
        phone: `9777${Date.now().toString().slice(-6)}`,
        dob: "1985-05-05",
        gender: "female",
        ignoreDuplicate: true,
      },
    });
    patientId = JSON.parse(patientRes.body).data.id;
  });

  it("should allow location_manager to create a manual invoice", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: managerCookies.join("; ") },
      payload: {
        patientId,
        locationId,
        doctorId,
        items: [{ description: "Misc Service", amount: 150, quantity: 1 }],
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("Clinic Essentials Cycle 4 — Consult Fee Dedupe", () => {
  let adminCookies: string[];
  let encounterId: string;
  let appointmentId: string;

  beforeAll(async () => {
    await app.ready();

    const orgRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Dedupe Org ${Date.now()}`,
        city: "Chennai",
        admin_name: "Dedupe Admin",
        admin_email: `dedupe-${Date.now()}@test.com`,
        admin_password: "Password123!",
      },
    });
    adminCookies = (await provisionedAdminCookies(orgRes));

    const locationRes = await reuseOnboardingLocation(app, { headers: { cookie: adminCookies.join("; ") }, payload: { name: "Dedupe Clinic", city: "Chennai" } });
    const locationId = JSON.parse(locationRes.body).data.id;

    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr Dedupe",
        email: `dr-dedupe-${Date.now()}@test.com`,
        password: "Password123!",
        specialization: "General",
      },
    });
    const doctorId = JSON.parse(docRes.body).data.id;

    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: { doctorId, locationId, fees: 400, workingHours: "00:00 - 23:59" },
    });

    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        locationId,
        doctorId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "walk-in",
        patientDetails: {
          name: "Dedupe Patient",
          dob: "1993-04-04",
          gender: "male",
          phone: `9888${Date.now().toString().slice(-6)}`,
          email: `dedupe-patient-${Date.now()}@test.com`,
        },
      },
    });
    expect(apptRes.statusCode).toBe(201);
    appointmentId = JSON.parse(apptRes.body).data.id;
    const patientId = JSON.parse(apptRes.body).data.patientId;

    const bookingInvoice = await Invoice.findOne({ appointmentId });
    expect(bookingInvoice).toBeTruthy();

    const encounterRes = await app.inject({
      method: "POST",
      url: "/api/encounters",
      headers: { cookie: adminCookies.join("; ") },
      payload: { locationId, patientId, doctorId, appointmentId, encounterType: "opd" },
    });
    encounterId = JSON.parse(encounterRes.body).data.id;
  });

  it("should not duplicate consultation fee on encounter auto-invoice when booking invoice exists", async () => {
    const previewRes = await app.inject({
      method: "GET",
      url: `/api/encounters/${encounterId}/charges-preview`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(previewRes.statusCode).toBe(200);
    const items = JSON.parse(previewRes.body).data.items as Array<{ category: string }>;
    expect(items.some((i) => i.category === "consultation")).toBe(false);

    const invoiceRes = await app.inject({
      method: "POST",
      url: `/api/encounters/${encounterId}/auto-invoice`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(invoiceRes.statusCode).toBe(201);
    const encounterInvoice = JSON.parse(invoiceRes.body).data;
    expect(encounterInvoice).toBeTruthy();
    expect(encounterInvoice.appointmentId).toBe(appointmentId);

    const duplicateEncounterInvoices = await Invoice.find({ encounterId, appointmentId: { $ne: appointmentId } });
    expect(duplicateEncounterInvoices.length).toBe(0);
  });

  it.each(["unpaid", "partially_paid", "paid"] as const)("does not recapture a consultation already billed on a %s invoice", async (status) => {
    const bookingInvoice = await Invoice.findOne({ appointmentId });
    expect(bookingInvoice).toBeTruthy();
    const originalStatus = bookingInvoice!.status;
    try {
      await Invoice.updateOne({ _id: bookingInvoice!._id }, { $set: { status } });
      const preview = await app.inject({
        method: "GET",
        url: `/api/encounters/${encounterId}/charges-preview`,
        headers: { cookie: adminCookies.join("; ") },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(JSON.parse(preview.body).data.items.some((item: { category: string }) => item.category === "consultation")).toBe(false);
    } finally {
      await Invoice.updateOne({ _id: bookingInvoice!._id }, { $set: { status: originalStatus } });
    }
  });

  it("still captures consultation when the linked invoice only bills lab services", async () => {
    const bookingInvoice = await Invoice.findOne({ appointmentId });
    expect(bookingInvoice).toBeTruthy();
    const originalItems = bookingInvoice!.items.toObject();
    try {
      await Invoice.updateOne({ _id: bookingInvoice!._id }, { $set: { items: [{ description: "Lab Test: CBC", amount: 400, quantity: 1 }] } });
      const preview = await app.inject({
        method: "GET",
        url: `/api/encounters/${encounterId}/charges-preview`,
        headers: { cookie: adminCookies.join("; ") },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(JSON.parse(preview.body).data.items.filter((item: { category: string }) => item.category === "consultation")).toHaveLength(1);
    } finally {
      await Invoice.updateOne({ _id: bookingInvoice!._id }, { $set: { items: originalItems } });
    }
  });

});

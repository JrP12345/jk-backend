import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Patient } from "../models/Patient.ts";
import { Clinic } from "../models/Clinic.ts";
import { Invoice } from "../models/Invoice.ts";

describe("Multi-Tenancy Data Isolation Integration Tests", () => {
  let orgACookies: string[];
  let orgBCookies: string[];
  let orgAPatientId: string;
  let orgAInvoiceId: string;

  beforeAll(async () => {
    await app.ready();

    await User.deleteMany({});
    await Organization.deleteMany({});
    await OrgMember.deleteMany({});
    await Patient.deleteMany({});
    await Clinic.deleteMany({});
    await Invoice.deleteMany({});

    // 1. Bootstrap Org A + Admin A
    const resOrgA = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Apollo Hospital Org A",
        city: "Mumbai",
        admin_name: "Admin A",
        admin_email: "adminA@orgA.com",
        admin_password: "Password123!"
      }
    });
    expect(resOrgA.statusCode).toBe(201);
    orgACookies = resOrgA.cookies.map((c: any) => `${c.name}=${c.value}`);

    // Create Clinic A for Org A
    const resClinicA = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: orgACookies.join("; ") },
      payload: { name: "Clinic A", city: "Mumbai" }
    });
    expect(resClinicA.statusCode).toBe(201);
    const clinicAId = JSON.parse(resClinicA.body).data.id;

    // 2. Bootstrap Org B + Admin B
    const resOrgB = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Fortis Healthcare Org B",
        city: "Delhi",
        admin_name: "Admin B",
        admin_email: "adminB@orgB.com",
        admin_password: "Password123!"
      }
    });
    expect(resOrgB.statusCode).toBe(201);
    orgBCookies = resOrgB.cookies.map((c: any) => `${c.name}=${c.value}`);

    // Create Doctor A for Org A
    const resDocA = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: orgACookies.join("; ") },
      payload: {
        name: "Dr. Doctor A",
        email: "doctorA@orgA.com",
        password: "Password123!",
        specialization: "Cardiology"
      }
    });
    expect(resDocA.statusCode).toBe(201);
    const docAUserId = JSON.parse(resDocA.body).data.id;

    // Assign Doctor A to Clinic A
    const resAssign = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: orgACookies.join("; ") },
      payload: { doctorId: docAUserId, clinicId: clinicAId, fees: 500, workingHours: "09:00 - 17:00" }
    });
    expect(resAssign.statusCode).toBe(201);

    // 3. Org A Admin creates Patient A in Org A
    const resAppointment = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: orgACookies.join("; ") },
      payload: {
        clinicId: clinicAId,
        doctorId: docAUserId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "walk-in",
        patientDetails: {
          name: "John Doe Patient A",
          dob: "1990-01-01",
          gender: "male",
          phone: "9876543210",
          email: "patientA@orga.com",
          password: "Password123"
        }
      }
    });
    expect(resAppointment.statusCode).toBe(201);
    orgAPatientId = JSON.parse(resAppointment.body).data.patientId;

    // Create Invoice for Org A
    const resInvoice = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: orgACookies.join("; ") },
      payload: {
        patientId: orgAPatientId,
        clinicId: clinicAId,
        doctorId: docAUserId,
        items: [{ description: "Blood Test", amount: 1500 }]
      }
    });
    expect(resInvoice.statusCode).toBe(201);
    orgAInvoiceId = JSON.parse(resInvoice.body).data.id;
  });

  it("should block Admin B from viewing Patient A details (returns 404 Not Found)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${orgAPatientId}`,
      headers: { cookie: orgBCookies.join("; ") }
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message || body.error).toContain("Patient not found");
  });

  it("should block Admin B from viewing Invoice A details (returns 404 Not Found)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/invoices/${orgAInvoiceId}`,
      headers: { cookie: orgBCookies.join("; ") }
    });

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message || body.error).toContain("Invoice not found");
  });

  it("should exclude Org A patients when Admin B searches for patients", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/patients?search=John",
      headers: { cookie: orgBCookies.join("; ") }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("should allow Admin A to view Patient A details successfully", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/patients/${orgAPatientId}`,
      headers: { cookie: orgACookies.join("; ") }
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patient.id).toBe(orgAPatientId);
  });
});

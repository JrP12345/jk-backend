import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { Invoice } from "../models/Invoice.ts";
import { Encounter } from "../models/Encounter.ts";
import { AuditLog } from "../models/AuditLog.ts";

describe("Universal Patient Record & Cross-Facility Access Tests", () => {
  let adminCookiesOrgA: string[] = [];
  let adminCookiesOrgB: string[] = [];
  let adminCookiesOrgC: string[] = [];
  let orgAId: string;
  let orgBId: string;
  let orgCId: string;
  let clinicAId: string;
  let clinicBId: string;
  let docAId: string;
  let docBId: string;
  let patient: any;

  beforeAll(async () => {
    // 1. Setup Organization A & Clinic A
    const bootOrgA = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Multi-Specialty ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Admin A",
        admin_email: `admin_a_${Date.now()}@apollo.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootOrgA.statusCode).toBe(201);
    adminCookiesOrgA = (bootOrgA.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgAId = JSON.parse(bootOrgA.body).data.organization.id;

    const clinicARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookiesOrgA.join("; ") },
      payload: { name: "Apollo Mumbai Central", city: "Mumbai" },
    });
    clinicAId = JSON.parse(clinicARes.body).data.id;

    const docARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookiesOrgA.join("; ") },
      payload: {
        name: "Dr. Arvind Sharma",
        email: `arvind_${Date.now()}@apollo.com`,
        password: "Password123",
        phone: "+919811122334",
        specialization: "Cardiology",
      },
    });
    docAId = JSON.parse(docARes.body).data.id;

    // 2. Setup Organization B & Clinic B
    const bootOrgB = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Fortis Healthcare ${Date.now()}`,
        city: "Delhi",
        admin_name: "Admin B",
        admin_email: `admin_b_${Date.now()}@fortis.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(bootOrgB.statusCode).toBe(201);
    adminCookiesOrgB = (bootOrgB.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgBId = JSON.parse(bootOrgB.body).data.organization.id;

    const clinicBRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookiesOrgB.join("; ") },
      payload: { name: "Fortis Delhi South", city: "Delhi" },
    });
    clinicBId = JSON.parse(clinicBRes.body).data.id;

    const docBRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookiesOrgB.join("; ") },
      payload: {
        name: "Dr. Neha Verma",
        email: `neha_${Date.now()}@fortis.com`,
        password: "Password123",
        phone: "+919811122335",
        specialization: "Internal Medicine",
      },
    });
    docBId = JSON.parse(docBRes.body).data.id;

    // 3. Setup Organization C (unrelated third party)
    const bootOrgC = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Max Healthcare ${Date.now()}`,
        city: "Bangalore",
        admin_name: "Admin C",
        admin_email: `admin_c_${Date.now()}@max.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    adminCookiesOrgC = (bootOrgC.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgCId = JSON.parse(bootOrgC.body).data.organization.id;

    // 4. Create Universal Patient registered at Org A
    patient = await Patient.create({
      organizationId: orgAId,
      name: "Ramesh Patel",
      phone: "+919876543210",
      email: "ramesh.patel@gmail.com",
      gender: "male",
      bloodGroup: "B+",
      allergies: ["Penicillin", "Sulfa drugs"],
      conditions: ["Type 2 Diabetes", "Hypertension"],
    });

    // 5. Create Encounter, Clinical Note, and Invoice at Org A
    const encA = await Encounter.create({
      organizationId: orgAId,
      clinicId: clinicAId,
      patientId: patient._id,
      doctorId: docAId,
      status: "completed",
      startedAt: new Date(Date.now() - 3600000),
      endedAt: new Date(),
    });

    await ClinicalNote.create({
      organizationId: orgAId,
      clinicId: clinicAId,
      encounterId: encA._id,
      patientId: patient._id,
      doctorId: docAId,
      version: 1,
      isLatest: true,
      status: "signed",
      subjective: {
        chiefComplaint: "Severe chest discomfort with shortness of breath",
        historyOfPresentIllness: "Ongoing for 3 days after meals",
      },
      objective: {
        physicalExamination: "BP 140/90, regular pulse",
      },
      assessment: {
        diagnoses: [{ code: "I10", description: "Essential Hypertension", status: "active" }],
      },
      plan: {
        treatmentPlan: "Prescribed Amlodipine 5mg OD, low sodium diet",
      },
      signature: {
        signerName: "Dr. Arvind Sharma",
        signedAt: new Date(),
      },
    });

    await Invoice.create({
      organizationId: orgAId,
      clinicId: clinicAId,
      doctorId: docAId,
      patientId: patient._id,
      invoiceNumber: `INV-APOLLO-${Date.now()}`,
      items: [{ description: "Cardiology Consult", quantity: 1, amount: 1200 }],
      subtotal: 1200,
      totalAmount: 1200,
      amountPaid: 1200,
      balanceDue: 0,
      status: "paid",
    });
  });

  it("Step 1: Verifies auto-generation of collision-resistant globalPatientId", async () => {
    expect(patient.globalPatientId).toBeDefined();
    expect(patient.globalPatientId).toMatch(/^UPI-\d{4}-\d{7}$/);
    expect(patient.mrn).toBeDefined();
  });

  it("Step 2: Without active appointment, Clinic B receives 404 (Multi-Tenant Isolation Protected)", async () => {
    const timelineRes = await app.inject({
      method: "GET",
      url: `/api/patients/${patient._id}/timeline`,
      headers: { cookie: adminCookiesOrgB.join("; ") },
    });

    // Masked with 404 for multi-tenancy security
    expect(timelineRes.statusCode).toBe(404);
  });

  it("Step 3: An appointment at Clinic B does not unlock records from Clinic A without patient OTP", async () => {
    // Book appointment for patient at Clinic B today
    await Appointment.create({
      organizationId: orgBId,
      clinicId: clinicBId,
      doctorId: docBId,
      patientId: patient._id,
      appointmentTime: new Date(),
      appointmentType: "online",
      status: "confirmed",
      tokenNumber: 1,
      queuePosition: 1,
    });

    const timelineRes = await app.inject({
      method: "GET",
      url: `/api/patients/${patient._id}/timeline?includeFinancial=true`,
      headers: { cookie: adminCookiesOrgB.join("; ") },
    });

    expect(timelineRes.statusCode).toBe(200);
    const body = JSON.parse(timelineRes.body);
    expect(body.success).toBe(true);

    const events = body.data.events;
    expect(events.every((event: any) => event.organizationId === orgBId)).toBe(true);
    expect(events.find((event: any) => event.title.includes("Apollo Mumbai Central"))).toBeUndefined();
    const fullHistory = await app.inject({ method: "GET", url: `/api/patients/${patient._id}/timeline?scope=all`, headers: { cookie: adminCookiesOrgB.join("; ") } });
    expect(fullHistory.statusCode).toBe(403);
    expect(await AuditLog.findOne({ action: "CROSS_ORG_PHI_READ", targetId: patient._id })).toBeNull();

  });

  it("Step 4: Third-party Clinic C without active appointment is still blocked with 404", async () => {
    const timelineResC = await app.inject({
      method: "GET",
      url: `/api/patients/${patient._id}/timeline`,
      headers: { cookie: adminCookiesOrgC.join("; ") },
    });

    expect(timelineResC.statusCode).toBe(404);
  });
});

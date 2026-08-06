import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { PreAuthorization } from "../models/PreAuthorization.ts";

describe("Insurance Claims & TPA Pre-Authorization Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let doctorUserId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Apex Super Specialty Hospital",
        city: "Hyderabad",
        admin_name: "TPA Admin",
        admin_email: `tpa_admin_${Date.now()}@apex.internal`,
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Central Insurance Desk Clinic",
        city: "Hyderabad",
        address: "300 Healthcare Park",
        phone: "9700066600",
        email: "tpa-desk@apex.internal",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Insured Patient Ramesh",
        email: `ramesh_tpa_${Date.now()}@patient.com`,
        phone: "9112233445",
        password: "Password123",
        role: "patient",
      },
    });
    expect(patientRes.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const { Patient: PatientModel } = await import("../models/Patient.ts");
    const patientDoc = await PatientModel.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();

    // 4. Register Doctor
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Arvind Rao",
        email: `dr.arvind_${Date.now()}@hospital.com`,
        specialization: "General Surgery",
        phone: "9876500112",
        role: "doctor",
        password: "Password123",
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorUserId = JSON.parse(docRes.body).data.id;
  });

  it("should submit a new cashless pre-authorization request via POST /api/pre-auth", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/pre-auth",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        doctorId: doctorUserId,
        tpaName: "Medi Assist TPA",
        policyNumber: "POL-99882211",
        diagnosisCode: "K80.20 (Calculus of gallbladder)",
        proposedTreatment: "Laparoscopic Cholecystectomy",
        requestedAmount: 85000,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.preAuthNumber).toMatch(/^PA-2026-\d{5}$/);
    expect(body.data.tpaName).toBe("Medi Assist TPA");
    expect(body.data.requestedAmount).toBe(85000);
    expect(body.data.status).toBe("submitted");
  });

  it("should retrieve pre-authorization requests via GET /api/pre-auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pre-auth?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].policyNumber).toBe("POL-99882211");
  });

  it("should update pre-authorization approval status and generate validUntil via PUT /api/pre-auth/:id", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/pre-auth?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    const preAuthItem = JSON.parse(listRes.body).data[0];
    const preAuthId = preAuthItem._id || preAuthItem.id;

    const updateRes = await app.inject({
      method: "PUT",
      url: `/api/pre-auth/${preAuthId}`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "approved",
        approvedAmount: 75000,
        approvalCode: "MA-APPR-90124",
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updated = JSON.parse(updateRes.body).data;
    expect(updated.status).toBe("approved");
    expect(updated.approvedAmount).toBe(75000);
    expect(updated.approvalCode).toBe("MA-APPR-90124");
    expect(updated.validUntil).toBeDefined();
  });
});

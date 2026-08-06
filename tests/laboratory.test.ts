import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";

describe("Pathology Laboratory & LIS Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;
  let doctorUserId: string;
  let testId: string;
  let orderId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Metropolis Pathology Diagnostics",
        city: "Pune",
        admin_name: "Lab Admin",
        admin_email: `lab_admin_${Date.now()}@metropolis.internal`,
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
        name: "Central Clinical Pathology Lab",
        city: "Pune",
        address: "50 Diagnostic Hub",
        phone: "9300022200",
        email: "lab@metropolis.internal",
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
        name: "Pathology Patient Vikram",
        email: `vikram_lab_${Date.now()}@patient.com`,
        phone: "9876543321",
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
        name: "Dr. Sunita Kulkarni",
        email: `dr.sunita_${Date.now()}@hospital.com`,
        specialization: "Pathology",
        phone: "9123411223",
        role: "doctor",
        password: "Password123",
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorUserId = JSON.parse(docRes.body).data.id;
  });

  it("should create a new lab test entry in catalog via POST /api/lab/tests", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lab-tests",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        name: "Glycated Hemoglobin (HbA1c)",
        code: `HBA1C-${Date.now()}`,
        department: "Biochemistry",
        sampleType: "Whole Blood (EDTA)",
        price: 650,
        normalRange: "4.0% - 5.6% (Non-Diabetic)",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("Glycated Hemoglobin (HbA1c)");
    expect(body.data.price).toBe(650);
    testId = body.data.id || body.data._id;
  });

  it("should retrieve lab test catalog via GET /api/lab/tests", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/lab-tests?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it("should place a diagnostic lab order via POST /api/lab/orders", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lab-orders",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        doctorId: doctorUserId,
        testId,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("ordered");
    orderId = body.data.id || body.data._id;
  });

  it("should update lab order status to sample-collected via PUT /api/lab/orders/:id/status", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/lab-orders/${orderId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "sample-collected",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("sample-collected");
  });

  it("should upload lab result and complete order via PUT /api/lab/orders/:id/result", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/lab-orders/${orderId}/result`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        resultValue: "5.8%",
        resultNotes: "Pre-diabetic range. Diet and exercise modification recommended.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("result-uploaded");
    expect(body.data.resultValue).toBe("5.8%");
  });

  it("should retrieve TAT metrics via GET /api/lab/tat-metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/lab/tat-metrics?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.tatSummary).toBeDefined();
    expect(body.data.tatSummary.tatCompliancePercent).toBeGreaterThanOrEqual(0);
  });
});

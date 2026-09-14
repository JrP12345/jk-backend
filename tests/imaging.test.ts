import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { ImagingStudy } from "../models/ImagingStudy.ts";

describe("Radiology & PACS Imaging Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;

  beforeAll(async () => {
    process.env.PACS_BASE_URL = "https://pacs.test/dicom-web";
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Radiology Diagnostics Center",
        city: "Mumbai",
        admin_name: "Radiology Admin",
        admin_email: `rad_admin_${Date.now()}@imaging.internal`,
        admin_password: "Password123",
        plan: "enterprise",
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
        name: "Advanced Imaging & MRI Wing",
        city: "Mumbai",
        address: "700 Diagnostic Boulevard",
        phone: "9900011000",
        email: "pacs@imaging.internal",
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
        name: "Vikram Sethi",
        email: `vikram_${Date.now()}@patient.com`,
        phone: "9876543210",
        password: "Password123",
        role: "patient",
      },
    });
    expect(patientRes.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const { Patient } = await import("../models/Patient.ts");
    const patientDoc = await Patient.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
  });

  it("should create a PACS DICOM imaging study request via POST /api/radiology/studies", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/radiology/studies",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        modality: "CT",
        studyDescription: "CT High Resolution Chest with Contrast",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.modality).toBe("CT");
    expect(body.data.status).toBe("requested");
    expect(body.data.studyInstanceUid).toBeDefined();
  });

  it("should list imaging studies with modality filters via GET /api/radiology/studies", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/radiology/studies?clinicId=${clinicId}&modality=CT`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].modality).toBe("CT");
  });

  it("should update imaging study status via PUT /api/radiology/studies/:id/status", async () => {
    // Create MRI study
    const createRes = await app.inject({
      method: "POST",
      url: "/api/radiology/studies",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        modality: "MR",
        studyDescription: "MRI Brain 3T T1/T2 Flair",
      },
    });
    const createData = JSON.parse(createRes.body).data;
    const studyId = createData._id || createData.id;

    // Update status to in_progress
    const statusRes = await app.inject({
      method: "PUT",
      url: `/api/radiology/studies/${studyId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: { status: "in_progress" },
    });

    expect(statusRes.statusCode).toBe(200);
    const updated = JSON.parse(statusRes.body).data;
    expect(updated.status).toBe("in_progress");
  });

  it("should attach and digitally sign radiology report via PUT /api/radiology/studies/:id/report", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/radiology/studies",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientId,
        modality: "DX",
        studyDescription: "Digital Chest X-Ray PA View",
      },
    });
    const reportData = JSON.parse(createRes.body).data;
    const studyId = reportData._id || reportData.id;

    const reportRes = await app.inject({
      method: "PUT",
      url: `/api/radiology/studies/${studyId}/report`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        radiologyReport: "Clinical Impression: Lungs clear bilaterally. No focal pulmonary consolidation, effusion, or pneumothorax. Heart size within normal limits.",
      },
    });

    expect(reportRes.statusCode).toBe(200);
    const reportedStudy = JSON.parse(reportRes.body).data;
    expect(reportedStudy.status).toBe("reported");
    expect(reportedStudy.radiologyReport).toContain("Lungs clear bilaterally");
  });
});

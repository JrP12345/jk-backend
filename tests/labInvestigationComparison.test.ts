import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { LabOrder } from "../models/LabOrder.ts";
import { LabTest } from "../models/LabTest.ts";
import { User } from "../models/User.ts";

describe("In-Cabin Lab Investigation Report Viewer & 1-Click Comparison Suite", () => {
  let adminCookies: string[] = [];
  let otherOrgCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let patient: any;
  let hba1cTest: any;
  let creatinineTest: any;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Diagnostics Network ${Date.now()}`,
        city: "Pune",
        admin_name: "Lab Admin",
        admin_email: `lab_admin_${Date.now()}@health.com`,
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
        name: "Pune Central Diagnostic Center",
        city: "Pune",
        upiVpa: "punediag@icici",
        merchantName: "Pune Diagnostics",
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
        name: "Dr. Vikram Kulkarni",
        email: `vikram_${Date.now()}@health.com`,
        password: "Password123",
        specialization: "Endocrinology",
        consultationFee: 900,
        clinicIds: [clinicId],
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    await DoctorAssignment.create({
      organizationId: orgId,
      doctorId,
      clinicId,
      fees: 900,
      workingHours: "[]",
      isActive: true,
    });

    // 4. Setup Patient
    const userDoc = await User.create({
      name: "Gaurav Sen",
      email: `gaurav_${Date.now()}@patient.com`,
      phone: "+919811223344",
      role: "patient",
      password: "Password123",
    });

    patient = await Patient.create({
      organizationId: orgId,
      userId: userDoc._id,
      name: "Gaurav Sen",
      phone: "+919811223344",
      gender: "male",
      dob: new Date("1985-06-15"),
      bloodGroup: "O+",
    });

    // 5. Setup Catalog Tests
    hba1cTest = await LabTest.create({
      organizationId: orgId,
      clinicId,
      name: "HbA1c Glycated Hemoglobin",
      code: "HBA1C",
      department: "Biochemistry",
      sampleType: "Whole Blood",
      normalRange: "< 5.7 %",
      price: 600,
    });

    creatinineTest = await LabTest.create({
      organizationId: orgId,
      clinicId,
      name: "Serum Creatinine",
      code: "CREAT",
      department: "Biochemistry",
      sampleType: "Serum",
      normalRange: "0.7 - 1.3 mg/dL",
      price: 250,
    });

    // 6. Setup Unrelated Organization for Access Isolation Test
    const otherOrgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Other Unrelated Org ${Date.now()}`,
        city: "Delhi",
        admin_name: "Unrelated Admin",
        admin_email: `unrelated_${Date.now()}@health.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(otherOrgRes.statusCode).toBe(201);
    otherOrgCookies = (otherOrgRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
  });

  it("1. Aggregates lab orders and appointment investigation results with attachments and chronological delta comparison", async () => {
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const today = new Date();

    // Baseline HbA1c Lab Order (2 months ago: 9.2 %)
    await LabOrder.create({
      organizationId: orgId,
      clinicId,
      patientId: patient._id,
      testId: hba1cTest._id,
      doctorId,
      status: "result-uploaded",
      orderDate: twoMonthsAgo,
      resultedAt: twoMonthsAgo,
      resultValue: "9.2 %",
      resultNotes: "Baseline poorly controlled diabetic profile",
      attachmentUrl: "https://r2.storage/reports/hba1c_baseline.pdf",
    });

    // Today's Follow-Up HbA1c Lab Order (8.4 %)
    await LabOrder.create({
      organizationId: orgId,
      clinicId,
      patientId: patient._id,
      testId: hba1cTest._id,
      doctorId,
      status: "result-uploaded",
      orderDate: today,
      resultedAt: today,
      resultValue: "8.4 %",
      resultNotes: "Noticeable improvement on Metformin regimen",
      attachmentUrl: "https://r2.storage/reports/hba1c_followup.pdf",
    });

    // Appointment with Serum Creatinine investigation result
    await Appointment.create({
      organizationId: orgId,
      clinicId,
      doctorId,
      patientId: patient._id,
      appointmentTime: oneMonthAgo,
      appointmentType: "walk-in",
      status: "completed",
      tokenNumber: 301,
      investigationResults: [
        {
          testId: creatinineTest._id,
          testName: "Serum Creatinine",
          value: "1.1 mg/dL",
          unit: "mg/dL",
          referenceRange: "0.7 - 1.3",
          isAbnormal: false,
          resultNotes: "Normal baseline renal function",
          attachmentUrl: "https://r2.storage/reports/creatinine_scan.jpg",
          resultedAt: oneMonthAgo,
        },
      ],
    });

    // Call Patient Lab Comparison endpoint
    const res = await app.inject({
      method: "GET",
      url: `/api/lab/patient/${patient._id}/comparison`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patientId).toBe(patient._id.toString());
    expect(body.data.totalTestsTracked).toBe(2);

    // Verify HbA1c comparison and delta
    const hba1cData = body.data.tests["HbA1c Glycated Hemoglobin"];
    expect(hba1cData).toBeDefined();
    expect(hba1cData.latest.value).toBe("8.4 %");
    expect(hba1cData.latest.numericValue).toBe(8.4);
    expect(hba1cData.latest.attachmentUrl).toBe("https://r2.storage/reports/hba1c_followup.pdf");

    expect(hba1cData.previous.value).toBe("9.2 %");
    expect(hba1cData.previous.numericValue).toBe(9.2);

    expect(hba1cData.delta).toBe(-0.8);
    expect(hba1cData.percentChange).toBe(-8.7);
    expect(hba1cData.history).toHaveLength(2);

    // Verify Serum Creatinine
    const creatData = body.data.tests["Serum Creatinine"];
    expect(creatData).toBeDefined();
    expect(creatData.latest.value).toBe("1.1 mg/dL");
    expect(creatData.latest.numericValue).toBe(1.1);
    expect(creatData.latest.attachmentUrl).toBe("https://r2.storage/reports/creatinine_scan.jpg");
    expect(creatData.previous).toBeNull();
    expect(creatData.delta).toBeNull();
  });

  it("2. Filters comparison results by testName query parameter", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/lab/patient/${patient._id}/comparison?testName=Creatinine`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalTestsTracked).toBe(1);
    expect(body.data.tests["Serum Creatinine"]).toBeDefined();
    expect(body.data.tests["HbA1c Glycated Hemoglobin"]).toBeUndefined();
  });

  it("3. Enforces multi-tenant isolation and denies unauthorized cross-org patient access", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/lab/patient/${patient._id}/comparison`,
      headers: { cookie: otherOrgCookies.join("; ") },
    });

    // Should reject with 403 or 404 Forbidden
    expect([403, 404]).toContain(res.statusCode);
  });
});

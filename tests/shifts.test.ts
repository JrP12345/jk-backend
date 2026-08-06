import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { ShiftRoster } from "../models/ShiftRoster.ts";

describe("Shift Roster & Staff Scheduling Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let adminUserId: string;
  let shiftId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "HealthOS Shift Roster Hospital",
        subdomain: `shift-roster-${Date.now()}`,
        admin_email: `admin_shift_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Shift Manager Lead",
        city: "Hyderabad",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgBody = JSON.parse(orgRes.body);
    orgId = orgBody.data.organization._id || orgBody.data.organization.id;

    adminCookies = orgRes.headers["set-cookie"] as string[];
    const adminUser = orgBody.data.adminUser || orgBody.data.admin || orgBody.data.user;
    adminUserId = adminUser?._id?.toString() || adminUser?.id || new mongoose.Types.ObjectId().toString();

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Main Ward Clinic",
        code: `MWC-${Date.now()}`,
        city: "Hyderabad",
        address: "100 Ward Street",
        phone: "9100055000",
        email: "shiftward@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    const clinicBody = JSON.parse(clinicRes.body);
    clinicId = clinicBody.data.id;
  });

  afterAll(async () => {
    if (ShiftRoster) {
      await ShiftRoster.deleteMany({ clinicId });
    }
    await app.close();
  });

  it("should create a new shift roster entry for a nurse", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/shifts",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        staffId: adminUserId,
        staffName: "Nurse Sarah Jenkins",
        staffRole: "Nurse",
        shiftDate: new Date().toISOString(),
        shiftType: "morning",
        startTime: "07:00",
        endTime: "15:00",
        ward: "ICU Ward A",
        assignedPatientsCount: 5,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.staffName).toBe("Nurse Sarah Jenkins");
    expect(body.data.ward).toBe("ICU Ward A");
    expect(body.data.status).toBe("scheduled");

    shiftId = body.data.id;
  });

  it("should fetch shifts list with KPI metrics and nurse-to-patient ratio", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/shifts?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.shifts.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.totalScheduled).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.nurseToPatientRatio).toBeDefined();
  });

  it("should check-in nurse and update shift status", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/shifts/${shiftId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "checked_in",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("checked_in");
    expect(body.data.checkInTime).toBeDefined();
  });

  it("should update shift handover notes", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/shifts/${shiftId}/handover`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        handoverNotes: "Patient Bed 4 stability improved post IV fluids. Vitals checked at 14:00.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.handoverNotes).toContain("Patient Bed 4 stability improved");
  });
});

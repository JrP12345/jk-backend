import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";

describe("Doctor Holiday & Leave Override Workflow Suite", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctorId: string;
  let patientId: string;
  let holidayDateStr: string;
  let holidayOverrideId: string;

  beforeAll(async () => {
    // 1. Setup Organization & Super Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Holiday Care Clinic ${Date.now()}`,
        city: "Pune",
        admin_name: "Holiday Admin",
        admin_email: `holiday_admin_${Date.now()}@health.com`,
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
        name: "Holiday Care Central",
        city: "Pune",
        address: "Deccan Gymkhana, Pune",
        phone: "+919888877777",
        email: "deccan@holidaycare.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Doctor with normal working hours (Monday-Saturday 09:00 - 17:00)
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Vikram Sarabhai",
        email: `dr_vikram_${Date.now()}@holidaycare.com`,
        phone: `97${Math.floor(10000000 + Math.random() * 90000000)}`,
        password: "Password123",
        specialization: "Internal Medicine",
        qualification: "MBBS, MD",
        experience_years: 12,
        clinicId,
        fees: 600,
        feeType: "fixed",
      },
    });
    expect(docRes.statusCode).toBe(201);
    doctorId = JSON.parse(docRes.body).data.id;

    const { DoctorAssignment } = await import("../models/DoctorAssignment.ts");
    await DoctorAssignment.findOneAndUpdate(
      { doctorId, clinicId },
      {
        fees: 600,
        feeType: "fixed",
        bookingMode: "time_slot",
        appointmentDuration: 30,
        workingHours: JSON.stringify({
          Monday: ["09:00-18:00"],
          Tuesday: ["09:00-18:00"],
          Wednesday: ["09:00-18:00"],
          Thursday: ["09:00-18:00"],
          Friday: ["09:00-18:00"],
          Saturday: ["09:00-18:00"],
          Sunday: ["09:00-18:00"],
        }),
        isActive: true,
      },
      { upsert: true, new: true }
    );

    // 4. Setup Patient
    const patientRes = await app.inject({
      method: "POST",
      url: "/api/patients",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Ramesh Sharma",
        phone: `98${Math.floor(10000000 + Math.random() * 90000000)}`,
        gender: "male",
        age: 35,
      },
    });
    expect(patientRes.statusCode).toBe(201);
    patientId = JSON.parse(patientRes.body).data.id;

    // Calculate a target weekday 3 days from now
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 3);
    if (targetDate.getDay() === 0) { // If Sunday, move to Monday
      targetDate.setDate(targetDate.getDate() + 1);
    }
    holidayDateStr = targetDate.toISOString().slice(0, 10);
  });

  it("1. Should successfully declare a holiday/leave override for doctor across clinics", async () => {
    const overrideRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: "all",
        doctorId,
        date: holidayDateStr,
        status: "unavailable",
        reason: "Diwali Festival Holiday",
      },
    });

    expect(overrideRes.statusCode).toBe(200);
    const body = JSON.parse(overrideRes.body);
    expect(body.success).toBe(true);
    expect(body.data.override.status).toBe("unavailable");
    expect(body.data.override.reason).toBe("Diwali Festival Holiday");
    holidayOverrideId = body.data.override.id || body.data.override._id;
  });

  it("2. Public clinic details API should reflect doctor's upcoming holidays", async () => {
    const clinicRes = await app.inject({
      method: "GET",
      url: `/api/public/clinics/${clinicId}`,
    });

    expect(clinicRes.statusCode).toBe(200);
    const body = JSON.parse(clinicRes.body);
    const doc = body.data.doctors.find((d: any) => d.id === doctorId);
    expect(doc).toBeDefined();
    expect(doc.upcomingHolidays).toBeDefined();
    expect(Array.isArray(doc.upcomingHolidays)).toBe(true);
    const holiday = doc.upcomingHolidays.find((h: any) => h.date === holidayDateStr);
    expect(holiday).toBeDefined();
    expect(holiday.reason).toBe("Diwali Festival Holiday");
  });

  it("3. Doctor slots API should report isHoliday: true and isWorkingDay: false on holiday date", async () => {
    const slotsRes = await app.inject({
      method: "GET",
      url: `/api/doctors/${doctorId}/slots?clinicId=${clinicId}&date=${holidayDateStr}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(slotsRes.statusCode).toBe(200);
    const body = JSON.parse(slotsRes.body);
    expect(body.data.isHoliday).toBe(true);
    expect(body.data.isWorkingDay).toBe(false);
    expect(body.data.holidayReason).toBe("Diwali Festival Holiday");
    expect(body.data.slots).toHaveLength(0);
  });

  it("4. Booking appointment on declared holiday date should be rejected with 400", async () => {
    const bookRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        patientId,
        appointmentTime: `${holidayDateStr}T10:00:00.000Z`,
        appointmentType: "online",
      },
    });

    expect(bookRes.statusCode).toBe(400);
    const body = JSON.parse(bookRes.body);
    expect(body.message).toContain("Doctor is on holiday / leave");
    expect(body.message).toContain("Diwali Festival Holiday");
  });

  it("5. Should retrieve doctor overrides list with populated clinic details", async () => {
    const getRes = await app.inject({
      method: "GET",
      url: `/api/doctor-overrides?doctorId=${doctorId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(Array.isArray(body.data)).toBe(true);
    const found = body.data.find((o: any) => o.date === holidayDateStr);
    expect(found).toBeDefined();
    expect(found.reason).toBe("Diwali Festival Holiday");
    expect(found.clinicId).toBeDefined();
    expect(found.clinicId.name).toBe("Holiday Care Central");
  });

  it("6. Cancelling the holiday override should restore availability and permit booking", async () => {
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/doctor-overrides/${holidayOverrideId}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(deleteRes.statusCode).toBe(200);

    // Verify slots are restored
    const slotsRes = await app.inject({
      method: "GET",
      url: `/api/doctors/${doctorId}/slots?clinicId=${clinicId}&date=${holidayDateStr}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(slotsRes.statusCode).toBe(200);
    const slotsBody = JSON.parse(slotsRes.body);
    expect(slotsBody.data.isHoliday).toBe(false);
    expect(slotsBody.data.isWorkingDay).toBe(true);
    expect(slotsBody.data.slots.length).toBeGreaterThan(0);

    // Verify booking now succeeds
    const bookRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        patientId,
        appointmentTime: `${holidayDateStr}T10:00:00.000Z`,
        appointmentType: "online",
      },
    });
    expect(bookRes.statusCode).toBe(201);
  });
});

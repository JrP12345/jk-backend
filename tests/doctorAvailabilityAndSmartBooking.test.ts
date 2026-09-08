import { describe, it, expect } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";

describe("Doctor Availability Overrides & Smart Booking Tests", () => {
  let adminCookies: string[] = [];
  let patientCookies: string[] = [];
  let orgId1: string;
  let clinicId1: string;
  let doctorUserId: string;
  let patientUserId: string;
  let patientProfileId: string;

  let orgId2: string;
  let clinicId2: string;

  it("should setup organizations, clinic, doctor, and patient", async () => {
    // 1. Setup Org 1 + Admin
    const bootstrapRes1 = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Apollo Super Care ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Dr. Admin",
        admin_email: `admin_${Date.now()}@apollo.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    adminCookies = (bootstrapRes1.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId1 = JSON.parse(bootstrapRes1.body).data.organization.id;

    // 2. Setup Clinic 1
    const clinicRes1 = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Apollo OPD West", city: "Mumbai" },
    });
    clinicId1 = JSON.parse(clinicRes1.body).data.id;

    // 3. Setup Doctor in Org 1
    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Rohit Sharma",
        email: `rohit_${Date.now()}@apollo.com`,
        password: "Password123",
        specialization: "Cardiology",
      },
    });
    doctorUserId = JSON.parse(docRes.body).data.id;

    // 4. Assign Doctor with specific hours (10:00 - 13:00, time_slot mode)
    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        doctorId: doctorUserId,
        clinicId: clinicId1,
        fees: 500,
        appointmentDuration: 15,
        bookingMode: "time_slot",
        workingHours: JSON.stringify([{ start: "10:00", end: "13:00" }]),
      },
    });

    // 5. Setup Patient
    const patRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        name: "Aakash Patel",
        email: `aakash_${Date.now()}@test.com`,
        password: "Password123",
      },
    });
    patientCookies = (patRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    const patUser = await User.findOne({ email: JSON.parse(patRes.body).data.user.email });
    patientUserId = patUser!._id.toString();
    const patProfile = await Patient.findOne({ userId: patientUserId });
    patientProfileId = patProfile!._id.toString();

    // 6. Setup a separate Org 2 + Clinic 2 to test cross-organization booking
    const bootstrapRes2 = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Fortis Healthcare ${Date.now()}`,
        city: "Delhi",
        admin_name: "Fortis Admin",
        admin_email: `admin_${Date.now()}@fortis.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    const org2AdminCookies = (bootstrapRes2.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId2 = JSON.parse(bootstrapRes2.body).data.organization.id;

    const clinicRes2 = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: org2AdminCookies.join("; ") },
      payload: { name: "Fortis Delhi Hub", city: "Delhi" },
    });
    clinicId2 = JSON.parse(clinicRes2.body).data.id;

    // Add doctor in Org 2
    const docRes2 = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: org2AdminCookies.join("; ") },
      payload: {
        name: "Dr. Ananya Roy",
        email: `ananya_${Date.now()}@fortis.com`,
        password: "Password123",
        specialization: "Dermatology",
      },
    });
    const doc2UserId = JSON.parse(docRes2.body).data.id;

    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: org2AdminCookies.join("; ") },
      payload: {
        doctorId: doc2UserId,
        clinicId: clinicId2,
        fees: 600,
        appointmentDuration: 15,
        bookingMode: "sequential_queue",
        workingHours: JSON.stringify([{ start: "09:00", end: "17:00" }]),
      },
    });
  });

  it("should reject bookings outside doctor working hours in time_slot mode", async () => {
    // Next Tuesday at 08:00 AM (doctor only works 10:00 - 13:00)
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 3);
    targetDate.setHours(8, 0, 0, 0);

    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: patientCookies.join("; ") },
      payload: {
        clinicId: clinicId1,
        doctorId: doctorUserId,
        appointmentTime: targetDate.toISOString(),
        appointmentType: "online",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain("outside practitioner working hours");
  });

  it("should allow booking when inside doctor working hours", async () => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 3);
    targetDate.setHours(10, 30, 0, 0);

    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: patientCookies.join("; ") },
      payload: {
        clinicId: clinicId1,
        doctorId: doctorUserId,
        appointmentTime: targetDate.toISOString(),
        appointmentType: "online",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.tokenNumber).toBe(1);
  });

  it("should support setting DoctorDayOverride to unavailable and cascade cancellations", async () => {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 3);
    const dateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, "0")}-${String(targetDate.getDate()).padStart(2, "0")}`;

    // Admin sets doctor unavailable on that day
    const overrideRes = await app.inject({
      method: "POST",
      url: "/api/doctor-overrides",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId: clinicId1,
        doctorId: doctorUserId,
        date: dateStr,
        status: "unavailable",
        reason: "Attending Annual Medical Conference",
      },
    });

    expect(overrideRes.statusCode).toBe(200);
    const overrideBody = JSON.parse(overrideRes.body);
    expect(overrideBody.success).toBe(true);
    expect(overrideBody.data.override.status).toBe("unavailable");
    expect(overrideBody.data.affectedSummary.autoCancelled).toBeGreaterThanOrEqual(1);

    // Verify slot service reflects unavailable override
    const slotsRes = await app.inject({
      method: "GET",
      url: `/api/doctors/${doctorUserId}/slots?clinicId=${clinicId1}&date=${dateStr}`,
      headers: { cookie: patientCookies.join("; ") },
    });
    expect(slotsRes.statusCode).toBe(200);
    const slotsBody = JSON.parse(slotsRes.body);
    expect(slotsBody.data.isWorkingDay).toBe(false);
    expect(slotsBody.data.overrideActive).toBe(true);

    // Attempting a new booking on that day should now be rejected
    targetDate.setHours(11, 0, 0, 0);
    const bookRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: patientCookies.join("; ") },
      payload: {
        clinicId: clinicId1,
        doctorId: doctorUserId,
        appointmentTime: targetDate.toISOString(),
        appointmentType: "online",
      },
    });
    expect(bookRes.statusCode).toBe(400);
    expect(JSON.parse(bookRes.body).message).toContain("Attending Annual Medical Conference");
  });

  it("should allow universal patient records to book across organizations", async () => {
    // Patient was originally created in Org 1 context. Now patient books at Org 2 (Fortis Delhi Hub).
    const doc2 = await DoctorAssignment.findOne({ clinicId: clinicId2 });
    expect(doc2).toBeTruthy();

    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + 2);
    targetDate.setHours(11, 0, 0, 0);

    const crossOrgBookingRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: patientCookies.join("; ") },
      payload: {
        clinicId: clinicId2,
        doctorId: doc2!.doctorId.toString(),
        appointmentTime: targetDate.toISOString(),
        appointmentType: "online",
        notes: "Consultation in Delhi",
      },
    });

    expect(crossOrgBookingRes.statusCode).toBe(201);
    const body = JSON.parse(crossOrgBookingRes.body);
    expect(body.success).toBe(true);
    expect(body.data.clinicId).toBe(clinicId2);
  });

  it("should calculate adaptive EWT using completed encounters", async () => {
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);

    // Check initial queue status (no completed encounters today -> default duration)
    const initialStatusRes = await app.inject({
      method: "GET",
      url: `/api/queue/status?clinicId=${clinicId1}&doctorId=${doctorUserId}&date=${todayStr}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(initialStatusRes.statusCode).toBe(200);
    const initialData = JSON.parse(initialStatusRes.body).data;
    expect(initialData.isAdaptiveDuration).toBe(false);

    // Seed 2 completed encounters for this doctor today (with 8 min actual durations)
    const encounter1Start = new Date();
    encounter1Start.setHours(10, 0, 0, 0);
    const encounter1End = new Date(encounter1Start.getTime() + 8 * 60 * 1000); // 8 mins

    const encounter2Start = new Date();
    encounter2Start.setHours(10, 10, 0, 0);
    const encounter2End = new Date(encounter2Start.getTime() + 10 * 60 * 1000); // 10 mins

    await Encounter.create([
      {
        organizationId: orgId1,
        clinicId: clinicId1,
        doctorId: doctorUserId,
        patientId: patientProfileId,
        status: "completed",
        startedAt: encounter1Start,
        endedAt: encounter1End,
      },
      {
        organizationId: orgId1,
        clinicId: clinicId1,
        doctorId: doctorUserId,
        patientId: patientProfileId,
        status: "completed",
        startedAt: encounter2Start,
        endedAt: encounter2End,
      },
    ]);

    // Check queue status again -> should now adapt to rolling average (~9 mins)
    const adaptiveStatusRes = await app.inject({
      method: "GET",
      url: `/api/queue/status?clinicId=${clinicId1}&doctorId=${doctorUserId}&date=${todayStr}`,
      headers: { cookie: adminCookies.join("; ") },
    });
    expect(adaptiveStatusRes.statusCode).toBe(200);
    const adaptiveData = JSON.parse(adaptiveStatusRes.body).data;
    expect(adaptiveData.isAdaptiveDuration).toBe(true);
    expect(adaptiveData.averageDuration).toBe(9); // (8 + 10) / 2 = 9 minutes
    expect(adaptiveData.adaptiveSampleCount).toBe(2);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { DoctorDayOverride } from "../models/DoctorDayOverride.ts";
import { Appointment } from "../models/Appointment.ts";

describe("Physical-to-Digital Bridge (Clinic QR Poster, Mobile Self-Registration & Thermal Token Slips)", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let doctor1Id: string;
  let doctor2Id: string;

  beforeAll(async () => {
    // 1. Bootstrap Healthcare Organization & Admin
    const bootstrapRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Bridge Health System ${Date.now()}`,
        city: "Mumbai",
        admin_name: "Operations Director",
        admin_email: `bridge_admin_${Date.now()}@bridgehealth.com`,
        admin_password: "Password123",
        plan: "pro",
      },
    });
    expect(bootstrapRes.statusCode).toBe(201);
    adminCookies = (bootstrapRes.headers["set-cookie"] as string[]).map((c) => c.split(";")[0]);
    orgId = JSON.parse(bootstrapRes.body).data.organization.id;

    // 2. Setup Clinic Facility
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Metro Wellness & OPD Clinic",
        city: "Mumbai",
        address: "Plot 42, Bandra Kurla Complex",
        phone: "+91 9820011223",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Setup Primary Doctor
    const doc1Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Ananya Roy",
        email: `ananya_${Date.now()}@bridgehealth.com`,
        password: "Password123",
        specialization: "Internal Medicine",
      },
    });
    expect(doc1Res.statusCode).toBe(201);
    doctor1Id = JSON.parse(doc1Res.body).data.id;

    // 4. Setup Secondary Doctor (for on-leave testing)
    const doc2Res = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Rajiv Singhal",
        email: `rajiv_${Date.now()}@bridgehealth.com`,
        password: "Password123",
        specialization: "Cardiology",
      },
    });
    expect(doc2Res.statusCode).toBe(201);
    doctor2Id = JSON.parse(doc2Res.body).data.id;

    // 5. Assign both doctors to clinic with sequential queue mode
    await DoctorAssignment.create({
      doctorId: doctor1Id,
      clinicId,
      organizationId: orgId,
      fees: 500,
      appointmentDuration: 15,
      bookingMode: "sequential_queue",
      isActive: true,
      workingHours: JSON.stringify({ all: { start: "08:00", end: "23:59" } }),
    });

    await DoctorAssignment.create({
      doctorId: doctor2Id,
      clinicId,
      organizationId: orgId,
      fees: 600,
      appointmentDuration: 20,
      bookingMode: "sequential_queue",
      isActive: true,
      workingHours: JSON.stringify({ all: { start: "08:00", end: "23:59" } }),
    });
  });

  it("1. should fetch public clinic details with live doctors, wait estimates & availability", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/public/clinics/${clinicId}`,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.id || body.data._id).toBe(clinicId);
    expect(body.data.name).toBe("Metro Wellness & OPD Clinic");
    expect(body.data.doctors).toHaveLength(2);

    const doc1 = body.data.doctors.find((d: any) => d.doctorId === doctor1Id);
    expect(doc1).toBeDefined();
    expect(doc1.name).toBe("Dr. Ananya Roy");
    expect(doc1.specialization).toBe("Internal Medicine");
    expect(doc1.waitingPatientsCount).toBe(0);
    expect(doc1.estimatedWaitMinutes).toBe(0);
  });

  it("2. should allow in-person walk-in patient to scan QR poster and join queue (Step: Scan → Join → Token)", async () => {
    const patientPhone = "9876543210";
    const res = await app.inject({
      method: "POST",
      url: "/api/public/join-queue",
      payload: {
        clinicId,
        doctorId: doctor1Id,
        name: "Suresh Tendulkar",
        phone: patientPhone,
        gender: "male",
        notes: "Acute seasonal fever & body ache",
      },
    });

    expect([200, 201]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.appointmentId).toBeDefined();
    expect(body.data.tokenNumber).toBeGreaterThanOrEqual(1);
    expect(body.data.isExisting).toBe(false);
    expect(body.data.trackingUrl).toBe(`/track/${body.data.appointmentId}`);

    // Verify appointment was created in DB with status: "checked-in"
    const appt = await Appointment.findById(body.data.appointmentId);
    expect(appt).toBeDefined();
    expect(appt?.status).toBe("checked-in");
    expect(appt?.appointmentType).toBe("walk-in");
    expect(appt?.tokenNumber).toBe(body.data.tokenNumber);

    // Verify patient profile was linked or created
    const patient = await Patient.findById(appt?.patientId);
    expect(patient).toBeDefined();
    expect(patient?.name).toBe("Suresh Tendulkar");
    expect(patient?.phone).toBe(patientPhone);
  });

  it("3. should prevent duplicate tokens when same patient re-scans QR poster on the same day", async () => {
    const patientPhone = "9876543210";

    // Second scan attempt for the same doctor today
    const res = await app.inject({
      method: "POST",
      url: "/api/public/join-queue",
      payload: {
        clinicId,
        doctorId: doctor1Id,
        name: "Suresh Tendulkar",
        phone: patientPhone,
        gender: "male",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Should return the EXISTING token, without creating a duplicate
    expect(body.data.isExisting).toBe(true);
    expect(body.message).toContain("already hold active Token");
    expect(body.data.trackingUrl).toContain("/track/");
  });

  it("4. should reject queue join if doctor is marked unavailable/on-leave today via DoctorDayOverride", async () => {
    // Put Dr. Rajiv Singhal on leave today
    const todayStr = new Date().toISOString().slice(0, 10);

    await DoctorDayOverride.create({
      clinicId,
      doctorId: doctor2Id,
      date: todayStr,
      status: "unavailable",
      reason: "Attending National Medical Conference",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/public/join-queue",
      payload: {
        clinicId,
        doctorId: doctor2Id,
        name: "Meena Kumari",
        phone: "9123456780",
        gender: "female",
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain("Doctor is unavailable today: Attending National Medical Conference");
  });

  it("5. should guarantee atomic sequential tokens without collisions under concurrent walk-ins", async () => {
    const concurrentRequests = [
      { name: "Patient Alpha", phone: "9811111111" },
      { name: "Patient Beta", phone: "9822222222" },
      { name: "Patient Gamma", phone: "9833333333" },
    ];

    const responses = await Promise.all(
      concurrentRequests.map((p) =>
        app.inject({
          method: "POST",
          url: "/api/public/join-queue",
          payload: {
            clinicId,
            doctorId: doctor1Id,
            name: p.name,
            phone: p.phone,
            gender: "other",
          },
        })
      )
    );

    const tokens: number[] = [];
    for (const res of responses) {
      expect([200, 201]).toContain(res.statusCode);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      tokens.push(body.data.tokenNumber);
    }

    // All tokens must be strictly unique (no collisions)
    const uniqueTokens = new Set(tokens);
    expect(uniqueTokens.size).toBe(tokens.length);

    // Tokens must be strictly ascending
    const sortedTokens = [...tokens].sort((a, b) => a - b);
    for (let i = 1; i < sortedTokens.length; i++) {
      expect(sortedTokens[i]).toBeGreaterThan(sortedTokens[i - 1]);
    }
  });

  it("6. should verify live queue tracking endpoint immediately reflects walk-in patient status and queue details", async () => {
    // Register another walk-in patient to test the tracker
    const joinRes = await app.inject({
      method: "POST",
      url: "/api/public/join-queue",
      payload: {
        clinicId,
        doctorId: doctor1Id,
        name: "Deepak Chopra",
        phone: "9844444444",
        gender: "male",
      },
    });

    expect([200, 201]).toContain(joinRes.statusCode);
    const appointmentId = JSON.parse(joinRes.body).data.appointmentId;
    const tokenNumber = JSON.parse(joinRes.body).data.tokenNumber;

    // Fetch tracker
    const trackRes = await app.inject({
      method: "GET",
      url: `/api/public/track/${appointmentId}`,
    });

    expect(trackRes.statusCode).toBe(200);
    const trackerBody = JSON.parse(trackRes.body);
    expect(trackerBody.success).toBe(true);
    expect(trackerBody.data.appointmentId).toBe(appointmentId);
    expect(trackerBody.data.tokenNumber).toBe(tokenNumber);
    expect(trackerBody.data.status).toBe("checked-in");
    expect(trackerBody.data.doctor.name).toBe("Dr. Ananya Roy");
    expect(trackerBody.data.clinic.name).toBe("Metro Wellness & OPD Clinic");
    expect(trackerBody.data.queuePosition).toBeGreaterThanOrEqual(1);
  });
});

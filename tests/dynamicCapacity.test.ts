import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Encounter } from "../models/Encounter.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { getAdaptiveConsultationDuration } from "../controllers/queue.ts";

describe("Dynamic Capacity & Damped Hybrid Duration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let locationId: string;
  let doctorId: string;
  let patient: any;

  beforeAll(async () => {
    // 1. Setup Org, Location & Doctor
    const boot = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `Capacity Care Hospital ${Date.now()}`,
        city: "Hyderabad",
        admin_name: "Admin Capacity",
        admin_email: `capacity_${Date.now()}@hospital.com`,
        admin_password: "Password123",
        plan: "enterprise",
      },
    });
    expect(boot.statusCode).toBe(201);
    adminCookies = (await provisionedAdminCookies(boot));
    orgId = JSON.parse(boot.body).data.organization.id;

    const locationRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/locations",
      headers: { cookie: adminCookies.join("; ") },
      payload: { name: "Hyderabad Jubilee Clinic", city: "Hyderabad" },
    });
    locationId = JSON.parse(locationRes.body).data.id;

    const docRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Dr. Sandeep Rao",
        email: `sandeep_${Date.now()}@hospital.com`,
        password: "Password123",
        phone: "+919833333333",
        specialization: "Pediatrics",
      },
    });
    doctorId = JSON.parse(docRes.body).data.id;

    // Doctor works today from 08:00 to 20:00 (for general test predictability)
    await DoctorAssignment.create({
      doctorId,
      locationId,
      organizationId: orgId,
      workingHours: JSON.stringify({ all: { start: "08:00", end: "20:00" } }),
      fees: 500,
      appointmentDuration: 15, // Baseline default
      onlineBookingSafetyBuffer: 30, // 30-min buffer
      bookingMode: "sequential_queue",
      isActive: true,
    });

    patient = await Patient.create({
      organizationId: orgId,
      name: "Ananya Rao",
      phone: "+919844444444",
      gender: "female",
    });
  });

  it("Step 1: Verifies Damped Hybrid Duration correctly blends default and today's average with bounds", async () => {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    // Initial check without completed consultations: returns baseline 15 mins
    const initial = await getAdaptiveConsultationDuration(locationId, doctorId, startOfToday, endOfToday, 15);
    expect(initial.isAdaptive).toBe(false);
    expect(initial.duration).toBe(15);

    // Create 2 completed encounters averaging 35 minutes each (35 mins is an outlier compared to 15 min default)
    const now = Date.now();
    await Encounter.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient._id,
      status: "completed",
      startedAt: new Date(now - 70 * 60 * 1000),
      endedAt: new Date(now - 35 * 60 * 1000), // 35 min
      createdAt: new Date(),
    });

    await Encounter.create({
      organizationId: orgId,
      locationId,
      doctorId,
      patientId: patient._id,
      status: "completed",
      startedAt: new Date(now - 35 * 60 * 1000),
      endedAt: new Date(now), // 35 min
      createdAt: new Date(),
    });

    // Formula: 0.6 * 15 + 0.4 * 35 = 9 + 14 = 23 mins.
    // Clamp: [0.75 * 15, 1.5 * 15] = [11, 23] -> max bound is 23 mins.
    const adaptive = await getAdaptiveConsultationDuration(locationId, doctorId, startOfToday, endOfToday, 15);
    expect(adaptive.isAdaptive).toBe(true);
    expect(adaptive.sampleCount).toBe(2);
    expect(adaptive.duration).toBe(23);
  });

  it("Step 2: Rejects same-day online booking when queue backlog enters the 30-minute safety buffer", async () => {
    // Override doctor working hours for today to end 45 minutes from now
    const now = new Date();
    const endMinutesTotal = now.getHours() * 60 + now.getMinutes() + 45;
    const endH = String(Math.floor(endMinutesTotal / 60)).padStart(2, "0");
    const endM = String(endMinutesTotal % 60).padStart(2, "0");

    const { DoctorDayOverride } = await import("../models/DoctorDayOverride.ts");
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await DoctorDayOverride.create({
      doctorId,
      locationId,
      date: todayStr,
      status: "available",
      effectiveEndTime: `${endH}:${endM}`,
    });

    // If shift ends in 45 mins, and safety buffer is 30 mins,
    // allowed online operating window is only 45 - 30 = 15 mins!
    // Since effective duration is 23 mins, even 0 waiting patients cannot fit within 15 mins!
    const onlineBookingRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        locationId,
        doctorId,
        appointmentTime: now.toISOString(),
        appointmentType: "online",
        patientDetails: {
          name: "Test Patient Queue",
          phone: "+919855555555",
          gender: "male",
          dob: "1990-01-01",
        },
      },
    });

    expect(onlineBookingRes.statusCode).toBe(409);
    const body = JSON.parse(onlineBookingRes.body);
    expect(body.message).toContain("safety buffer");

    // Staff force booking / walk-in can still book because 45 mins remaining > 23 mins!
    const staffBookingRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        locationId,
        doctorId,
        appointmentTime: now.toISOString(),
        appointmentType: "walk-in",
        forceBooking: true,
        patientDetails: {
          name: "Test Patient Queue Staff",
          phone: "+919855555556",
          gender: "male",
          dob: "1990-01-01",
        },
      },
    });

    expect(staffBookingRes.statusCode).toBe(201);
  });
});

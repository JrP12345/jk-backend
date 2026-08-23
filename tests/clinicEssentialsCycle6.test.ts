import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import {
  setupCeOrgFixture,
  createTestStaffMember,
  loginTestUser,
  onboardTestOrganization,
  createTestDoctor,
  cookieHeader,
} from "./helpers/clinicEssentialsSetup.ts";

describe("Clinic Essentials Cycle 6 — clinic_manager Desk Booking", () => {
  let managerCookies: string[];
  let clinicId: string;
  let doctorId: string;
  let patientId: string;

  beforeAll(async () => {
    await app.ready();

    const fixture = await setupCeOrgFixture(app, "cm-book", "CM Book Clinic");
    clinicId = fixture.clinicId;
    doctorId = fixture.doctorId;

    const managerEmail = `cm-book-mgr-${Date.now()}@test.com`;
    await createTestStaffMember(app, fixture.adminCookies, {
      name: "Booking Manager",
      email: managerEmail,
      role: "clinic_manager",
    });

    managerCookies = await loginTestUser(app, managerEmail);

    const patientRes = await app.inject({
      method: "POST",
      url: "/api/patients",
      headers: { cookie: managerCookies.join("; ") },
      payload: {
        name: "Walk-in CM Book",
        phone: `9111${Date.now().toString().slice(-6)}`,
        dob: "1990-02-02",
        gender: "male",
        ignoreDuplicate: true,
      },
    });
    patientId = JSON.parse(patientRes.body).data.id;
  });

  it("should allow clinic_manager to book walk-in appointments as confirmed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: managerCookies.join("; ") },
      payload: {
        clinicId,
        doctorId,
        patientId,
        appointmentTime: new Date().toISOString(),
        appointmentType: "walk-in",
      },
    });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.status).toBe("confirmed");
  });
});

describe("Clinic Essentials Cycle 6 — Doctor Review RBAC", () => {
  it("should reject staff from submitting doctor reviews", async () => {
    await app.ready();

    const { adminCookies } = await onboardTestOrganization(app, "review-rbac");
    const doctorUserId = await createTestDoctor(app, adminCookies, "review");

    const res = await app.inject({
      method: "POST",
      url: `/api/doctors/${doctorUserId}/reviews`,
      headers: cookieHeader(adminCookies),
      payload: { rating: 5 },
    });
    expect(res.statusCode).toBe(403);
  });
});

import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Doctor } from "../models/Doctor.ts";
import { Receptionist } from "../models/Receptionist.ts";

describe("Onboarding & Clinic API Integration Tests", () => {
  const adminEmail = "owner@test.com";
  const password = "Password123";
  let adminCookies: string[] = [];
  let organizationId: string;
  let clinicId: string;
  let doctorUserId: string;

  it("should successfully bootstrap a new organization and admin user", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Surat Medical Center",
        city: "Surat",
        admin_name: "Hitesh Patel",
        admin_email: adminEmail,
        admin_password: password,
        plan: "pro",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.organization.name).toBe("Surat Medical Center");
    expect(body.data.user.role).toBe("admin");

    organizationId = body.data.organization.id;

    // Save cookies
    adminCookies = response.headers["set-cookie"] as string[];
  });

  it("should allow admin to create a clinic location", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: {
        cookie: adminCookies.join("; "),
      },
      payload: {
        name: "Surat Clinic Branch A",
        city: "Surat",
        address: "123 Ring Road",
        phone: "9876543210",
        email: "brancha@test.com",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("Surat Clinic Branch A");
    clinicId = body.data.id;
  });

  it("should allow admin to add a doctor", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/doctor",
      headers: {
        cookie: adminCookies.join("; "),
      },
      payload: {
        name: "Dr. Ramesh Patel",
        email: "ramesh@test.com",
        password: "Password123",
        specialization: "Cardiology",
        qualification: "MD, DM",
        experience_years: 12,
        fees: 500,
        timings: JSON.stringify([{ start: "09:00", end: "13:00" }]),
        working_days: JSON.stringify(["Monday", "Wednesday", "Friday"]),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.role).toBe("doctor");
    doctorUserId = body.data.id;
  });

  it("should allow admin to add a receptionist assigned to clinic", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/receptionist",
      headers: {
        cookie: adminCookies.join("; "),
      },
      payload: {
        name: "Komal Vyas",
        email: "komal@test.com",
        password: "Password123",
        shift: "Morning",
        clinicId: clinicId,
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it("should block non-admin users from creating staff members", async () => {
    // Login as the doctor to get doctor's cookies
    const doctorLogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: {
        email: "ramesh@test.com",
        password: "Password123",
      },
    });
    const docCookies = doctorLogin.headers["set-cookie"] as string[];

    // Attempt to register another receptionist using doctor credentials
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/receptionist",
      headers: {
        cookie: docCookies.join("; "),
      },
      payload: {
        name: "Hack Receptionist",
        email: "hack@test.com",
        password: "Password123",
        clinicId: clinicId,
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("should allow admin to fetch settings and update settings of organization", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/onboarding/organization/me",
      headers: {
        cookie: adminCookies.join("; "),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("Surat Medical Center");

    const updateRes = await app.inject({
      method: "PUT",
      url: "/api/onboarding/organization/me",
      headers: {
        cookie: adminCookies.join("; "),
      },
      payload: {
        name: "Surat Medical Center Ltd",
        city: "Surat",
      },
    });

    expect(updateRes.statusCode).toBe(200);
    const updatedOrg = await Organization.findById(organizationId);
    expect(updatedOrg!.name).toBe("Surat Medical Center Ltd");
  });
});

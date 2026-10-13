import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Doctor } from "../models/Doctor.ts";
import { Receptionist } from "../models/Receptionist.ts";
import { DoctorAssignment } from "../models/DoctorAssignment.ts";
import { providerFixtureSlug } from "./helpers/providerFixture.ts";

describe("Onboarding & Clinic API Integration Tests", () => {
  const adminEmail = "owner@test.com";
  const password = "Password123";
  let adminCookies: string[] = [];
  let organizationId: string;
  let locationId: string;
  let doctorUserId: string;

  it("should successfully bootstrap a new organization and admin user", async () => {
    const response = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Surat Medical Center",
        city: "Surat",
        admin_name: "Hitesh Patel",
        admin_email: adminEmail,
        admin_password: password,
        plan: "professional",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.data.organization.name).toBe("Surat Medical Center");
    expect(body.data.user.role).toBe("admin");

    organizationId = body.data.organization.id;

    // Save cookies
    adminCookies = (await provisionedAdminCookies(response));
  });

  it("should allow admin to create a clinic location", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/onboarding/locations",
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
    locationId = body.data.id;
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
        locationId: locationId,
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
        locationId: locationId,
      },
    });

    expect(response.statusCode).toBe(403);
  });

  it("links an admin profile with its fee model while retaining the admin role and requiring explicit public assignment", async () => {
    const admin = await User.findOne({ email: adminEmail });
    const linked = await app.inject({ method: "POST", url: "/api/onboarding/admin/enable-doctor-profile", headers: { cookie: adminCookies.join("; ") }, payload: { specialization: "General Physician", qualification: "MBBS", fees: 650, feeType: "post_consultation" } });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().data).toMatchObject({ userId: admin!.id, fees: 650, feeType: "post_consultation" });
    expect((await User.findById(admin!._id))!.role).toBe("admin");
    expect(await DoctorAssignment.countDocuments({ doctorId: admin!._id })).toBe(0);
    const staff = await app.inject({ method: "GET", url: "/api/onboarding/staff", headers: { cookie: adminCookies.join("; ") } });
    expect(staff.json().data.doctors).toContainEqual(expect.objectContaining({ id: admin!.id, fees: 650, feeType: "post_consultation" }));
    const slug = await providerFixtureSlug("location", locationId);
    const before = await app.inject({ method: "GET", url: `/api/public/locations/${slug}` });
    expect(before.json().data.doctors.some((doctor: { id: string }) => doctor.id === admin!.id)).toBe(false);
    const assigned = await app.inject({ method: "POST", url: "/api/onboarding/doctors/assignments", headers: { cookie: adminCookies.join("; ") }, payload: { doctorId: admin!.id, locationId, fees: 650, feeType: "post_consultation", workingHours: JSON.stringify({ Monday: [{ start: "09:00", end: "17:00" }] }) } });
    expect(assigned.statusCode, assigned.body).toBe(201);
    const after = await app.inject({ method: "GET", url: `/api/public/locations/${slug}` });
    expect(after.json().data.doctors).toContainEqual(expect.objectContaining({ id: admin!.id, fees: 650, feeType: "post_consultation" }));
  });

  it("persists a free admin profile and returns the same fee model when setup resumes", async () => {
    const response = await app.inject({ method: "POST", url: "/api/onboarding/admin/enable-doctor-profile", headers: { cookie: adminCookies.join("; ") }, payload: { specialization: "General Physician", feeType: "free", fees: 500 } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toMatchObject({ feeType: "free", fees: 0 });
    const staff = await app.inject({ method: "GET", url: "/api/onboarding/staff", headers: { cookie: adminCookies.join("; ") } });
    expect(staff.json().data.doctors).toContainEqual(expect.objectContaining({ feeType: "free", fees: 0 }));
    const legacy = await app.inject({ method: "POST", url: "/api/onboarding/admin/enable-doctor-profile", headers: { cookie: adminCookies.join("; ") }, payload: { specialization: "General Physician" } });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json().data.feeType).toBe("free");
  });

  it("rejects invalid admin profile fees without overwriting the saved profile", async () => {
    const admin = await User.findOne({ email: adminEmail });
    const before = await Doctor.findOne({ userId: admin!._id }).lean();
    for (const payload of [{ feeType: "unknown" }, { fees: -1 }, { fees: "invalid" }]) {
      const response = await app.inject({ method: "POST", url: "/api/onboarding/admin/enable-doctor-profile", headers: { cookie: adminCookies.join("; ") }, payload: { specialization: "Invalid replacement", ...payload } });
      expect(response.statusCode, response.body).toBe(400);
    }
    expect(await Doctor.findOne({ userId: admin!._id }).lean()).toEqual(before);
  });

  it("retains fee models when a new doctor is created and edited, and rejects invalid assignment fee types", async () => {
    const created = await app.inject({ method: "POST", url: "/api/onboarding/doctor", headers: { cookie: adminCookies.join("; ") }, payload: { name: "Free Clinic Doctor", email: "free-doctor@test.com", password: "Password123!", specialization: "General Physician", fees: 500, feeType: "free" } });
    expect(created.statusCode, created.body).toBe(201);
    const userId = created.json().data.id;
    expect(await Doctor.findOne({ userId }).lean()).toMatchObject({ feeType: "free", fees: 0 });
    const updated = await app.inject({ method: "PUT", url: `/api/onboarding/doctor/${userId}`, headers: { cookie: adminCookies.join("; ") }, payload: { name: "Free Clinic Doctor", specialization: "General Physician", feeType: "post_consultation", fees: 200 } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(await Doctor.findOne({ userId }).lean()).toMatchObject({ feeType: "post_consultation", fees: 200 });
    const invalid = await app.inject({ method: "POST", url: "/api/onboarding/doctors/assignments", headers: { cookie: adminCookies.join("; ") }, payload: { doctorId: userId, locationId, workingHours: "{}", fees: 200, feeType: "unsupported" } });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(await DoctorAssignment.countDocuments({ doctorId: userId })).toBe(0);
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

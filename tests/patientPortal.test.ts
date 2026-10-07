import { provisioningFixtureHeaders, provisionedAdminCookies } from "./helpers/provisioningFixture.ts";
import { describe, it, expect, beforeAll } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";

describe("Patient Portal Self-Service Integration Tests", () => {
  let patientCookies: string[] = [];
  let patientUserId: string;
  let orgId: string;
  let locationId: string;
  let doctorId: string;

  beforeAll(async () => {
    // 1. Create Org & Admin
    const orgRes = await app.inject({ headers: await provisioningFixtureHeaders(),
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Patient Portal Test Hospital",
        subdomain: `patient-portal-${Date.now()}`,
        admin_email: `admin_portal_${Date.now()}@ekavyu.internal`,
        admin_password: "Password123!",
        admin_name: "Portal Admin",
        city: "Mumbai",
        plan: "enterprise",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgBody = JSON.parse(orgRes.body);
    orgId = orgBody.data.organization.id;
    const adminCookies = (await provisionedAdminCookies(orgRes));

    // 2. Create Location
    const locationRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/locations",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Self Service Clinic",
        code: `SSC-${Date.now()}`,
        city: "Mumbai",
        address: "50 Portal Road",
        phone: "9100077000",
        email: "portal@hospital.com",
      },
    });
    expect(locationRes.statusCode).toBe(201);
    locationId = JSON.parse(locationRes.body).data.id;

    // 3. Register Patient Account
    const regRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: {
        email: `patient_self_${Date.now()}@ekavyu.internal`,
        password: "Password123!",
        name: "Alex Mercer",
        role: "patient",
        locationId,
      },
    });
    expect(regRes.statusCode).toBe(201);
    patientCookies = (regRes.headers["set-cookie"] as string[]).map(c => c.split(";")[0]);
    patientUserId = JSON.parse(regRes.body).data.user.id;

    // Set doctor ID
    const adminUser = orgBody.data.adminUser || orgBody.data.admin || orgBody.data.user;
    doctorId = adminUser?._id?.toString() || adminUser?.id || new mongoose.Types.ObjectId().toString();
  });

  it("should retrieve logged in patient profile", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/patient/me",
      headers: { cookie: patientCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.email).toContain("patient_self_");
  });

  it("should update patient demographics & medical notes", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/patient/me",
      headers: { cookie: patientCookies.join("; ") },
      payload: {
        dob: "1994-05-12",
        gender: "male",
        bloodGroup: "O+",
        allergies: ["Penicillin"],
        medicalNotes: "No major surgeries. Mild asthma.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.bloodGroup).toBe("O+");
    expect(body.data.allergies).toContain("Penicillin");
  });

  it("should retrieve longitudinal medical records summary bundle", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/patient-portal/records",
      headers: { cookie: patientCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patient).toBeDefined();
    expect(body.data.exportedAt).toBeDefined();
  });
});

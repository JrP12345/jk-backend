import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Encounter } from "../models/Encounter.ts";
import { Claim } from "../models/Claim.ts";
import { OrgMember } from "../models/OrgMember.ts";
import bcrypt from "bcryptjs";

describe("Milestone 8: Analytics & Reporting Platform Integration Tests", () => {
  it("should fetch executive dashboard analytics", async () => {
    const org = await Organization.create({ name: "Analytics Health Org", city: "Hyderabad" });
    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "Analytics Main Clinic",
      city: "Hyderabad",
      address: "1 Analytics Plaza",
    });

    const adminUser = await User.create({
      name: "Analytics Admin",
      email: "analytics_admin@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin",
    });

    await OrgMember.create({
      organizationId: org._id,
      userId: adminUser._id,
      role: "admin",
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.9.0.1",
      payload: { email: "analytics_admin@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    const execRes = await app.inject({
      method: "GET",
      url: "/api/analytics/executive",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(execRes.statusCode).toBe(200);
    const data = JSON.parse(execRes.body).data;
    expect(data.overall).toBeDefined();
    expect(data.clinicsPerformance).toBeDefined();
  });

  it("should fetch clinical summary analytics", async () => {
    const org = await Organization.create({ name: "Clinical Analytics Org", city: "Kolkata" });
    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "Clinical Analytics Ward",
      city: "Kolkata",
      address: "77 Research Rd",
    });

    const docUser = await User.create({
      name: "Dr. Clinical Analytics",
      email: "dr_analytics@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "doctor",
    });

    const patientUser = await User.create({
      name: "Analytics Patient",
      email: "analytics_patient@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "patient",
    });

    const patient = await Patient.create({
      userId: patientUser._id,
      organizationId: org._id,
    });

    await Encounter.create({
      organizationId: org._id,
      clinicId: clinic._id,
      patientId: patient._id,
      doctorId: docUser._id,
      encounterType: "opd",
      status: "in_progress",
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.9.0.2",
      payload: { email: "dr_analytics@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    const summaryRes = await app.inject({
      method: "GET",
      url: "/api/analytics/clinical-summary",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(summaryRes.statusCode).toBe(200);
    const summary = JSON.parse(summaryRes.body).data;
    expect(summary.totalEncounters).toBeGreaterThanOrEqual(1);
    expect(summary.claimApprovalRate).toBeDefined();
  });

  it("should export analytics report in JSON and CSV formats", async () => {
    const adminUser = await User.create({
      name: "Export Admin",
      email: "export_admin@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin",
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.9.0.3",
      payload: { email: "export_admin@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // 1. Export JSON
    const jsonRes = await app.inject({
      method: "GET",
      url: "/api/analytics/export?format=json&reportType=executive",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(jsonRes.statusCode).toBe(200);
    expect(JSON.parse(jsonRes.body).data.reportType).toBe("executive");

    // 2. Export CSV
    const csvRes = await app.inject({
      method: "GET",
      url: "/api/analytics/export?format=csv&reportType=clinical",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers["content-type"]).toContain("text/csv");
    expect(csvRes.body).toContain("Metric,Value");
  });
});

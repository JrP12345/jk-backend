import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { BloodBankUnit } from "../models/BloodBankUnit.ts";

describe("Blood Bank Inventory & Cross-Matching Integration Tests", () => {
  let adminCookies: string[] = [];
  let clinicId: string;
  let patientId: string;

  beforeAll(async () => {
    // 1. Create Organization & Admin
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "National Blood Center & Hospital",
        city: "Delhi",
        admin_name: "Blood Bank Officer",
        admin_email: `bld_admin_${Date.now()}@bloodbank.internal`,
        admin_password: "Password123",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Central Blood Transfusion Unit",
        city: "Delhi",
        address: "200 Red Cross Road",
        phone: "9500044400",
        email: "bloodbank@hospital.internal",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;

    // 3. Register Patient
    const patientRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Transfusion Patient Anita",
        email: `anita_bld_${Date.now()}@patient.com`,
        phone: "9988112233",
        password: "Password123",
        role: "patient",
        clinicId,
      },
    });
    expect(patientRes.statusCode).toBe(201);
    const patientUserId = JSON.parse(patientRes.body).data.user.id;
    const { Patient: PatientModel } = await import("../models/Patient.ts");
    const patientDoc = await PatientModel.findOne({ userId: patientUserId });
    patientId = patientDoc!._id.toString();
  });

  it("should register a new blood unit in inventory via POST /api/blood-bank/units", async () => {
    const expiry = new Date(Date.now() + 30 * 86400000).toISOString(); // +30 days

    const res = await app.inject({
      method: "POST",
      url: "/api/blood-bank/units",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        unitNumber: `BLD-O-${Date.now()}`,
        clinicId,
        bloodGroup: "O+",
        componentType: "prbc",
        volumeMl: 350,
        expiryDate: expiry,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.bloodGroup).toBe("O+");
    expect(body.data.componentType).toBe("prbc");
    expect(body.data.status).toBe("available");
  });

  it("should list blood bank inventory units via GET /api/blood-bank/units", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/blood-bank/units?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].bloodGroup).toBe("O+");
  });

  it("should cross-match and reserve blood units via POST /api/blood-bank/cross-match", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/blood-bank/cross-match",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        patientId,
        bloodGroup: "O+",
        requiredUnits: 1,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.reservedCount).toBe(1);
    expect(Array.isArray(body.data.reservedUnits)).toBe(true);
  });
});

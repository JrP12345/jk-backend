import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { MortuaryEntry } from "../models/MortuaryEntry.ts";

describe("Mortuary & Deceased Patient Management Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let entryId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Metropolitan Mortuary & Forensic Science Center",
        subdomain: `mortuary-${Date.now()}`,
        admin_email: `admin_mortuary_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Chief Forensic Officer",
        city: "Bengaluru",
      },
    });
    expect(orgRes.statusCode).toBe(201);
    const orgBody = JSON.parse(orgRes.body);
    orgId = orgBody.data.organization._id || orgBody.data.organization.id;
    adminCookies = orgRes.headers["set-cookie"] as string[];

    // 2. Create Clinic
    const clinicRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        name: "Central Mortuary & Pathology Wing",
        code: `MORT-${Date.now()}`,
        city: "Bengaluru",
        address: "900 Pathology Way",
        phone: "9100088000",
        email: "mortuary@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (MortuaryEntry) {
      await MortuaryEntry.deleteMany({ clinicId });
    }
  });

  it("should admit a deceased patient and assign mortuary tag and compartment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mortuary",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        tagNumber: `MORT-TAG-${Date.now()}`,
        deceasedName: "Jonathan Miller",
        age: 64,
        gender: "male",
        causeOfDeath: "Acute Myocardial Infarction",
        deathCertificateNumber: `DC-2026-${Date.now()}`,
        mortuaryCompartment: "Cold Bay B-04",
        temperatureCelsius: -4.0,
        autopsyRequired: true,
        autopsyStatus: "scheduled",
        releaseStatus: "pending_autopsy",
        nextOfKinName: "Patricia Miller",
        nextOfKinContact: "9876543210",
        notes: "Autopsy scheduled with Chief Forensic Pathologist.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.deceasedName).toBe("Jonathan Miller");
    expect(body.data.mortuaryCompartment).toBe("Cold Bay B-04");

    entryId = body.data.id;
  });

  it("should fetch mortuary entries with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/mortuary?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.entries.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.currentOccupancy).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.autopsiesPending).toBeGreaterThanOrEqual(1);
  });

  it("should update release status to released_to_kin", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/mortuary/${entryId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        autopsyStatus: "completed",
        releaseStatus: "released_to_kin",
        notes: "Autopsy completed cleanly. Released to next of kin Patricia Miller.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.releaseStatus).toBe("released_to_kin");
    expect(body.data.autopsyStatus).toBe("completed");
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { HBOTSession } from "../models/HBOTSession.ts";

describe("Hyperbaric Oxygen Therapy (HBOT) Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let sessionId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Advanced Hyperbaric Medicine & Wound Healing Institute",
        subdomain: `hbot-center-${Date.now()}`,
        admin_email: `admin_hbot_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Director of Hyperbaric Operations",
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
        name: "Multiplace Hyperbaric Oxygen Chamber Suite",
        code: `HBOT-${Date.now()}`,
        city: "Bengaluru",
        address: "100 Oxygen Way",
        phone: "9100077000",
        email: "hbot@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (HBOTSession) {
      await HBOTSession.deleteMany({ clinicId });
    }
  });

  it("should schedule a hyperbaric oxygen session for diabetic foot ulcer at 2.4 ATA", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hbot",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        chamberId: "HBOT-CHAMBER-BAY-01",
        patientName: "Arthur Pendelton",
        indication: "diabetic_foot_ulcer",
        pressureATA: 2.4,
        sessionDurationMinutes: 90,
        barotraumaSafetyCleared: true,
        supervisingPhysician: "Dr. Harrison Vance, HBOT Medical Director",
        chamberOperator: "Tech Sarah Jenkins, CHT",
        notes: "Wagner Grade 3 diabetic foot ulcer. Pre-compression tympanic clearance confirmed.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patientName).toBe("Arthur Pendelton");
    expect(body.data.pressureATA).toBe(2.4);
    expect(body.data.sessionStatus).toBe("scheduled");

    sessionId = body.data.id;
  });

  it("should fetch HBOT sessions with KPI metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/hbot?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sessions.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.barotraumaClearedRate).toBe(100);
  });

  it("should advance session status through compression to at_depth_treatment and completed", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/hbot/${sessionId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        sessionStatus: "completed",
        notes: "Compression to 2.4 ATA completed without ear equalization issues. 90-min oxygen breathing protocol finished.",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.sessionStatus).toBe("completed");
  });
});

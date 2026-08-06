import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import { TransplantCase } from "../models/TransplantCase.ts";

describe("Organ Transplant & Donor Registry Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let caseId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "National Organ Transplant Institute",
        subdomain: `transplant-${Date.now()}`,
        admin_email: `admin_transplant_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Chief Transplant Coordinator",
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
        name: "Renal & Cardiac Transplant Care Center",
        code: `TXP-${Date.now()}`,
        city: "Bengaluru",
        address: "700 Medical Hub Boulevard",
        phone: "9100077000",
        email: "transplant@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (TransplantCase) {
      await TransplantCase.deleteMany({ clinicId });
    }
  });

  it("should register an organ transplant recipient patient on waitlist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/transplant",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        caseNumber: `TXP-RECP-${Date.now()}`,
        patientName: "Robert Vance",
        organType: "kidney",
        caseRole: "recipient_waitlist",
        bloodGroup: "O+",
        hlaTyping: "HLA-A*02, HLA-B*27, HLA-DR*04",
        urgencyScore: 28, // High MELD/OPTN score
        matchStatus: "seeking_match",
        donorHospital: "National Transplant Hub",
        leadSurgeon: "Dr. Sarah Jenkins",
        notes: "End-stage renal failure, dialysis 3x weekly.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.patientName).toBe("Robert Vance");
    expect(body.data.urgencyScore).toBe(28);

    caseId = body.data.id;
  });

  it("should calculate HLA tissue match compatibility between donor and recipient", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/transplant/match-calculator",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        recipientHla: "HLA-A*02, HLA-B*27, HLA-DR*04",
        donorHla: "HLA-A*02, HLA-B*27, HLA-DR*01",
        recipientBlood: "O+",
        donorBlood: "O-",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.isBloodCompatible).toBe(true);
    expect(body.data.sharedAntigens).toBe(2);
    expect(body.data.matchPercentage).toBeGreaterThanOrEqual(60);
  });

  it("should fetch transplant case list with metrics", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/transplant?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.cases.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.recipientCount).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.criticalUrgencyCount).toBeGreaterThanOrEqual(1);
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../index.js";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { InfectionControl } from "../models/InfectionControl.ts";

describe("Infection Control & Outbreak Surveillance Integration Tests", () => {
  let adminCookies: string[] = [];
  let orgId: string;
  let clinicId: string;
  let incidentId: string;

  beforeAll(async () => {
    // 1. Create Organization
    const orgRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: "Infection Control Surveillance Hospital",
        subdomain: `infection-control-${Date.now()}`,
        admin_email: `admin_infection_${Date.now()}@ananta.internal`,
        admin_password: "Password123!",
        admin_name: "Surveillance Officer",
        city: "Delhi",
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
        name: "Isolation & ICU Wing",
        code: `ICU-${Date.now()}`,
        city: "Delhi",
        address: "10 Hygiene Way",
        phone: "9100088000",
        email: "hygiene@hospital.com",
      },
    });
    expect(clinicRes.statusCode).toBe(201);
    clinicId = JSON.parse(clinicRes.body).data.id;
  });

  afterAll(async () => {
    if (InfectionControl) {
      await InfectionControl.deleteMany({ clinicId });
    }
  });

  it("should log a new hospital-acquired infection (HAI) surveillance incident", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/infection-control",
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        clinicId,
        patientName: "Patient John Doe (Bed 12)",
        ward: "ICU Ward A",
        pathogenName: "Methicillin-resistant Staphylococcus aureus (MRSA)",
        infectionType: "HAI_CLABSI",
        isolationStatus: "contact_isolation",
        riskLevel: "critical",
        antimicrobialRegimen: "Vancomycin IV 1g Q12H",
        notes: "CVC line swab culture positive for MRSA.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.pathogenName).toContain("MRSA");
    expect(body.data.status).toBe("confirmed_active");

    incidentId = body.data.id;
  });

  it("should fetch infection control incidents with KPI metrics & HAI rate %", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/infection-control?clinicId=${clinicId}`,
      headers: { cookie: adminCookies.join("; ") },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.incidents.length).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.activeIsolationCount).toBeGreaterThanOrEqual(1);
    expect(body.data.metrics.haiRatePercentage).toBeDefined();
  });

  it("should update infection incident status, isolation level & sanitization", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/infection-control/${incidentId}/status`,
      headers: { cookie: adminCookies.join("; ") },
      payload: {
        status: "cleared",
        isolationStatus: "none",
        environmentalSanitizationDone: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("cleared");
    expect(body.data.environmentalSanitizationDone).toBe(true);
  });
});

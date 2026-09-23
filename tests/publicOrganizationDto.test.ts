import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";

describe("SEC-001: Public Organization & Clinic Secret Containment", () => {
  let testOrgId: string;
  let testClinicId: string;
  const smtpPassSecret = "super-secret-smtp-password-999";
  const whatsappTokenSecret = "meta-access-token-secret-888";

  beforeAll(async () => {
    await app.ready();

    // Create an organization with sensitive credentials & internal SaaS limits
    const org = await Organization.create({
      name: "Apollo Secret Defense Org",
      address: "123 Healthcare Blvd",
      city: "Bangalore",
      phone: "+919876543210",
      email: "contact@apollosecret.org",
      description: "Premier multi-specialty healthcare facility",
      plan: "enterprise",
      maxClinics: 10,
      maxDoctors: 50,
      maxStaff: 50,
      taxId: "GSTIN-9988776655",
      licenseNumber: "CLINIC-LIC-443322",
      onboardingStatus: "COMPLETED",
      isOnboarded: true,
      isActive: true,
      smtp: {
        host: "smtp.internal.apollosecret.org",
        port: 587,
        secure: true,
        user: "mailer@apollosecret.org",
        pass: smtpPassSecret,
        fromEmail: "notifications@apollosecret.org",
        fromName: "Apollo Hospital System",
      },
      whatsappConfig: {
        mode: "dedicated",
        wabaId: "waba_enterprise_999",
        phoneNumberId: "phone_num_888",
        accessToken: whatsappTokenSecret,
        monthlyQuota: 10000,
        creditsBalance: 8500,
        creditsUsedThisMonth: 1500,
        lowBalanceThreshold: 500,
        notifications: {
          sendBookingConfirmation: true,
          sendConsultationComplete: true,
          sendAppointmentCancellation: true,
          sendTurnApproaching: true,
          sendQueueDelayAlert: true,
          sendDisruptionAlert: true,
        },
      },
    });
    testOrgId = org.id;

    // Create a clinic linked to this organization
    const clinic = await Clinic.create({
      organizationId: org._id,
      name: "Apollo Care Clinic Indiranagar",
      city: "Bangalore",
      phone: "+919876500000",
      email: "indiranagar@apollosecret.org",
      address: "100 Feet Road, Indiranagar",
      isActive: true,
    });
    testClinicId = clinic.id;
  });

  it("1. GET /api/public/organizations must NEVER return sensitive fields or credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/public/organizations",
    });

    expect(res.statusCode).toBe(200);
    const rawBody = res.body;

    // Critical: secret strings must not exist anywhere in raw response body
    expect(rawBody).not.toContain(smtpPassSecret);
    expect(rawBody).not.toContain(whatsappTokenSecret);

    const json = JSON.parse(rawBody);
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data)).toBe(true);

    const matchedOrg = json.data.find((o: any) => o.id === testOrgId || o._id === testOrgId);
    expect(matchedOrg).toBeDefined();

    // Verify secrets are strictly undefined on the returned DTO
    expect(matchedOrg.smtp).toBeUndefined();
    expect(matchedOrg.whatsappConfig).toBeUndefined();
    expect(matchedOrg.taxId).toBeUndefined();
    expect(matchedOrg.licenseNumber).toBeUndefined();
    expect(matchedOrg.plan).toBeUndefined();
    expect(matchedOrg.maxClinics).toBeUndefined();
    expect(matchedOrg.maxDoctors).toBeUndefined();
    expect(matchedOrg.maxStaff).toBeUndefined();
    expect(matchedOrg.onboardingStatus).toBeUndefined();
    expect(matchedOrg.isOnboarded).toBeUndefined();

    // Verify public contact & profile fields remain accessible
    expect(matchedOrg.name).toBe("Apollo Secret Defense Org");
    expect(matchedOrg.city).toBe("Bangalore");
    expect(matchedOrg.phone).toBe("+919876543210");
    expect(matchedOrg.email).toBe("contact@apollosecret.org");
    expect(matchedOrg.isActive).toBe(true);
  });

  it("2. GET /api/public/organizations/:id must NEVER return sensitive fields or credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/public/organizations/${testOrgId}`,
    });

    expect(res.statusCode).toBe(200);
    const rawBody = res.body;

    expect(rawBody).not.toContain(smtpPassSecret);
    expect(rawBody).not.toContain(whatsappTokenSecret);

    const json = JSON.parse(rawBody);
    expect(json.success).toBe(true);
    const org = json.data;

    // Verify complete absence of secrets and internal flags
    expect(org.smtp).toBeUndefined();
    expect(org.whatsappConfig).toBeUndefined();
    expect(org.taxId).toBeUndefined();
    expect(org.licenseNumber).toBeUndefined();
    expect(org.plan).toBeUndefined();
    expect(org.maxClinics).toBeUndefined();
    expect(org.maxDoctors).toBeUndefined();
    expect(org.maxStaff).toBeUndefined();
    expect(org.onboardingStatus).toBeUndefined();
    expect(org.isOnboarded).toBeUndefined();

    // Verify legitimate public fields
    expect(org.name).toBe("Apollo Secret Defense Org");
    expect(org.city).toBe("Bangalore");
    expect(org.description).toBe("Premier multi-specialty healthcare facility");
    expect(org.doctors).toBeDefined();
  });

  it("3. GET /api/public/clinics must not leak organization credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/public/clinics",
    });

    expect(res.statusCode).toBe(200);
    const rawBody = res.body;

    expect(rawBody).not.toContain(smtpPassSecret);
    expect(rawBody).not.toContain(whatsappTokenSecret);
  });

  it("4. GET /api/public/clinics/:id must project clean organization without credentials", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/public/clinics/${testClinicId}`,
    });

    expect(res.statusCode).toBe(200);
    const rawBody = res.body;

    expect(rawBody).not.toContain(smtpPassSecret);
    expect(rawBody).not.toContain(whatsappTokenSecret);

    const json = JSON.parse(rawBody);
    expect(json.success).toBe(true);
    const clinic = json.data;
    expect(clinic.organization).toBeDefined();
    expect(clinic.organization.name).toBe("Apollo Secret Defense Org");
    expect(clinic.organization.smtp).toBeUndefined();
    expect(clinic.organization.whatsappConfig).toBeUndefined();
    expect(clinic.organization.taxId).toBeUndefined();
  });

  it("5. Schema defense-in-depth: Organization.findById omits smtp.pass and whatsappConfig.accessToken by default", async () => {
    const orgDoc = await Organization.findById(testOrgId);
    expect(orgDoc).not.toBeNull();
    expect(orgDoc?.smtp?.pass).toBeFalsy();
    expect(orgDoc?.whatsappConfig?.accessToken).toBeFalsy();
  });

  it("6. Legitimate internal queries can explicitly select sensitive credentials via +fieldName", async () => {
    const orgDoc = await Organization.findById(testOrgId).select("+smtp.pass +whatsappConfig.accessToken");
    expect(orgDoc).not.toBeNull();
    expect(orgDoc?.smtp?.pass).toBe(smtpPassSecret);
    expect(orgDoc?.whatsappConfig?.accessToken).toBe(whatsappTokenSecret);
  });

  it("7. toJSON transform strips sensitive credentials even when explicitly selected", async () => {
    const orgDoc = await Organization.findById(testOrgId).select("+smtp.pass +whatsappConfig.accessToken");
    expect(orgDoc).not.toBeNull();
    const json = orgDoc!.toJSON();
    expect(json.smtp?.pass).toBeUndefined();
    expect(json.whatsappConfig?.accessToken).toBeUndefined();
  });
});

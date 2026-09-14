import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Clinic } from "../models/Clinic.ts";
import { Organization } from "../models/Organization.ts";
import { Appointment } from "../models/Appointment.ts";
import { Prescription } from "../models/Prescription.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { generateAccessToken, createRefreshToken } from "../utilities/helpers.ts";

describe("Security & Safety Hardening Verification Suite", () => {
  let orgId: string;
  let clinicId: string;
  let doctorUser: any;
  let doctorCookie: string;
  let testPatientUser: any;
  let testPatient: any;

  beforeAll(async () => {
    // Setup Organization & Clinic
    const org = await Organization.create({
      name: "Security Hardening Health",
      city: "Bangalore",
      email: `sec-${Date.now()}@health.test`,
      plan: "enterprise",
    });
    orgId = org._id.toString();

    const clinic = await Clinic.create({
      organizationId: orgId,
      name: "Security Hardening OPD",
      city: "Bangalore",
    });
    clinicId = clinic._id.toString();

    // Doctor Setup
    doctorUser = await User.create({
      name: "Dr. Security Officer",
      email: `doctor-sec-${Date.now()}@test.com`,
      password: "Password123!",
      role: "doctor",
    });

    const docToken = generateAccessToken({
      id: doctorUser._id.toString(),
      email: doctorUser.email,
      role: "doctor",
      organization_id: orgId,
    });
    const docRefresh = await createRefreshToken(doctorUser._id.toString(), { organizationId: orgId });
    doctorCookie = `access_token=${docToken}; refresh_token=${docRefresh}`;

    // Pre-existing Patient with medical history
    testPatientUser = await User.create({
      name: "Alice Original",
      phone: "9876500001",
      email: "alice.original@patient.test",
      role: "patient",
      authMethod: "phone_otp",
    });

    testPatient = await Patient.create({
      organizationId: orgId,
      userId: testPatientUser._id,
      name: "Alice Original",
      phone: "9876500001",
      email: "alice.original@patient.test",
      accountType: "self",
      allergies: ["Penicillin"],
      conditions: ["Hypertension"],
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 1. GUEST LOGIN SCOPING & ACCOUNT TAKEOVER PREVENTION
  // ──────────────────────────────────────────────────────────────────────────
  describe("1. Guest Login Scoping & Account Takeover Prevention", () => {
    it("should issue a scoped 'guest' session when an existing patient's phone is supplied and protect profile from tampering", async () => {
      // Attacker attempts guest login using Alice's verified phone number with Mallory's name
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/guest-login",
        payload: {
          phone: "9876500001",
          name: "Mallory Attacker",
        },
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body).data;

      // 1. Session must be strictly scoped to 'guest' (NOT 'patient')
      expect(data.user.role).toBe("guest");
      expect(data.user.permissions).toContain("CREATE_APPOINTMENTS");

      // 2. Existing patient's name must NOT be overwritten by unauthenticated guest
      expect(data.user.name).toBe("Alice Original");
      const userInDb = await User.findById(testPatientUser._id);
      expect(userInDb?.name).toBe("Alice Original");

      // 3. Sensitive patient record fields must not be leaked in response
      expect(data.patient).toHaveProperty("id");
      expect(data.patient).toHaveProperty("name");
      expect(data.patient.allergies).toBeUndefined();
      expect(data.patient.conditions).toBeUndefined();
    });

    it("should reject guest session access to patient portal EHR records and personal profile", async () => {
      const guestRes = await app.inject({
        method: "POST",
        url: "/api/auth/guest-login",
        payload: {
          phone: "9876500001",
          name: "Mallory Attacker",
        },
      });
      const guestCookies = guestRes.headers["set-cookie"] as string[];

      // Try accessing patient EHR medical records
      const recordsRes = await app.inject({
        method: "GET",
        url: "/api/patient-portal/records",
        headers: { cookie: Array.isArray(guestCookies) ? guestCookies.join("; ") : guestCookies },
      });
      expect(recordsRes.statusCode).toBe(403);

      // Try accessing patient profile
      const profileRes = await app.inject({
        method: "GET",
        url: "/api/patient/me",
        headers: { cookie: Array.isArray(guestCookies) ? guestCookies.join("; ") : guestCookies },
      });
      expect(profileRes.statusCode).toBe(403);

      // Try accessing DPDP data export
      const dpdpRes = await app.inject({
        method: "GET",
        url: "/api/dpdp/export",
        headers: { cookie: Array.isArray(guestCookies) ? guestCookies.join("; ") : guestCookies },
      });
      expect(dpdpRes.statusCode).toBe(403);
    });

    it("should preserve scoped 'guest' role when refresh token is rotated", async () => {
      const guestRes = await app.inject({
        method: "POST",
        url: "/api/auth/guest-login",
        payload: {
          phone: "9876500001",
          name: "Mallory Attacker",
        },
      });
      const guestCookies = guestRes.headers["set-cookie"] as string[];

      const refreshRes = await app.inject({
        method: "POST",
        url: "/api/auth/refresh-token",
        headers: { cookie: Array.isArray(guestCookies) ? guestCookies.join("; ") : guestCookies },
      });
      expect(refreshRes.statusCode).toBe(200);

      const rotatedCookies = refreshRes.headers["set-cookie"] as string[];
      // Access token after rotation should still be blocked from patient records
      const recordsRes = await app.inject({
        method: "GET",
        url: "/api/patient-portal/records",
        headers: { cookie: Array.isArray(rotatedCookies) ? rotatedCookies.join("; ") : rotatedCookies },
      });
      expect(recordsRes.statusCode).toBe(403);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 2. INBOUND WEBHOOK CRYPTOGRAPHIC VERIFICATION
  // ──────────────────────────────────────────────────────────────────────────
  describe("2. Inbound Webhook Cryptography", () => {
    const UPI_SECRET = "test_upi_webhook_secret_key_12345";
    const WHATSAPP_SECRET = "test_whatsapp_webhook_secret_key_67890";

    beforeAll(() => {
      process.env.UPI_WEBHOOK_SECRET = UPI_SECRET;
      process.env.META_WHATSAPP_APP_SECRET = WHATSAPP_SECRET;
    });

    afterAll(() => {
      delete process.env.UPI_WEBHOOK_SECRET;
      delete process.env.META_WHATSAPP_APP_SECRET;
    });

    it("should reject unsigned or fraudulently signed UPI webhook requests with 401", async () => {
      const payload = {
        transactionId: "TX_FORGED_101",
        amount: 500,
        status: "SUCCESS",
      };

      // 1. Missing signature
      const unsignedRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/upi",
        payload,
      });
      expect(unsignedRes.statusCode).toBe(401);

      // 2. Invalid signature header
      const invalidSigRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/upi",
        headers: { "x-webhook-signature": "invalid_hex_signature" },
        payload,
      });
      expect(invalidSigRes.statusCode).toBe(401);
    });

    it("should accept valid HMAC-SHA256 signed UPI webhook requests", async () => {
      const payload = {
        transactionId: "TX_VALID_102",
        amount: 500,
        status: "SUCCESS",
      };
      const rawPayload = JSON.stringify(payload);
      const validSig = crypto.createHmac("sha256", UPI_SECRET).update(rawPayload).digest("hex");

      const validRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/upi",
        headers: {
          "x-webhook-signature": validSig,
          "content-type": "application/json",
        },
        payload,
      });

      // Signature verification passed (correlation may return 404 because TX is synthetic, but auth passed)
      expect(validRes.statusCode).not.toBe(401);
    });

    it("should reject unsigned or forged WhatsApp webhook requests with 401", async () => {
      const payload = {
        object: "whatsapp_business_account",
        entry: [],
      };

      // 1. Missing signature
      const unsignedRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        payload,
      });
      expect(unsignedRes.statusCode).toBe(401);

      // 2. Invalid signature
      const invalidRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        headers: { "x-hub-signature-256": "sha256=invalid_hash" },
        payload,
      });
      expect(invalidRes.statusCode).toBe(401);
    });

    it("should accept valid HMAC-SHA256 signed WhatsApp webhook events", async () => {
      const payload = {
        object: "whatsapp_business_account",
        entry: [],
      };
      const rawPayload = JSON.stringify(payload);
      const validHmac = crypto.createHmac("sha256", WHATSAPP_SECRET).update(rawPayload).digest("hex");

      const validRes = await app.inject({
        method: "POST",
        url: "/api/webhooks/whatsapp",
        headers: {
          "x-hub-signature-256": `sha256=${validHmac}`,
          "content-type": "application/json",
        },
        payload,
      });

      expect(validRes.statusCode).toBe(200);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // 3. CLINICAL PRESCRIPTION SAFETY (CDS) ENFORCEMENT IN ENCOUNTER COMPLETION
  // ──────────────────────────────────────────────────────────────────────────
  describe("3. Clinical Prescription Safety (CDS) in Doctor Encounter Completion", () => {
    let appointment: any;

    beforeAll(async () => {
      // Create an appointment for Alice (who is allergic to Penicillin) with Dr. Security
      appointment = await Appointment.create({
        organizationId: orgId,
        clinicId,
        doctorId: doctorUser._id,
        patientId: testPatient._id,
        appointmentTime: new Date(),
        appointmentType: "walk-in",
        tokenNumber: 101,
        status: "in-consultation",
      });
    });

    it("should block completion when prescribing Penicillin derivative without override justification", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/api/appointments/${appointment._id}/status`,
        headers: { cookie: doctorCookie },
        payload: {
          status: "completed",
          prescriptions: [
            {
              name: "Amoxicillin 500mg",
              dosage: "500mg",
              frequency: "1-0-1",
              duration: "5 days",
            },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code).toBe("CDS_SAFETY_CONTRAINDICATION");
      expect(body.criticalFindings.length).toBeGreaterThanOrEqual(1);

      const allergyFinding = body.criticalFindings.find((f: any) => f.findingType === "allergy");
      expect(allergyFinding).toBeDefined();
      expect(allergyFinding.severity).toBe("critical");

      // Verify appointment was NOT marked completed and no prescription was created
      const apptCheck = await Appointment.findById(appointment._id);
      expect(apptCheck?.status).toBe("in-consultation");

      const rxCount = await Prescription.countDocuments({ appointmentId: appointment._id });
      expect(rxCount).toBe(0);

      // Verify blocked attempt was recorded in CDSEvaluation
      const blockedEval = await CDSEvaluation.findOne({
        patientId: testPatient._id,
        clinicianDecision: "blocked",
      });
      expect(blockedEval).not.toBeNull();
    });

    it("should succeed and record clinical audit trail when clinician provides override reason", async () => {
      const overrideReason = "Skin prick testing negative; desensitization protocol administered under clinical observation.";

      const res = await app.inject({
        method: "PUT",
        url: `/api/appointments/${appointment._id}/status`,
        headers: { cookie: doctorCookie },
        payload: {
          status: "completed",
          prescriptions: [
            {
              name: "Amoxicillin 500mg",
              dosage: "500mg",
              frequency: "1-0-1",
              duration: "5 days",
            },
          ],
          cdsOverrideReason: overrideReason,
        },
      });

      expect(res.statusCode).toBe(200);

      // Verify appointment is now completed
      const apptCheck = await Appointment.findById(appointment._id);
      expect(apptCheck?.status).toBe("completed");

      // Verify prescription was persisted
      const rx = await Prescription.findOne({
        patientId: testPatient._id,
        medicineName: "Amoxicillin 500mg",
      });
      expect(rx).not.toBeNull();

      // Verify CDSEvaluation record was created with 'overridden'
      const evalDoc = await CDSEvaluation.findOne({
        patientId: testPatient._id,
        clinicianDecision: "overridden",
      });
      expect(evalDoc).not.toBeNull();
      expect(evalDoc?.overrideReason).toBe(overrideReason);
    });
  });
});

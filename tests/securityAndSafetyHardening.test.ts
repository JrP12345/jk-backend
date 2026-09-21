import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import mongoose from "mongoose";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Clinic } from "../models/Clinic.ts";
import { Organization } from "../models/Organization.ts";
import { Appointment } from "../models/Appointment.ts";
import { Invoice } from "../models/Invoice.ts";
import { AppointmentPayment } from "../models/AppointmentPayment.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { Prescription } from "../models/Prescription.ts";
import { CDSEvaluation } from "../models/CDSEvaluation.ts";
import { generateAccessToken, createRefreshToken } from "../utilities/helpers.ts";
import { createTrackerCapability } from "../utilities/publicTracker.ts";

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
  // 1. PUBLIC BOOKING SESSION SCOPING
  // ──────────────────────────────────────────────────────────────────────────
  describe("1. Public Booking Session Scoping", () => {
    it("should issue a scoped 'guest' session when booking with an existing patient's phone and protect the profile from tampering", async () => {
      // Public booking must not overwrite an existing account profile.
      const res = await app.inject({
        method: "POST",
        url: "/api/public/booking-session",
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

    it("does not expose the retired guest-auth URLs", async () => {
      for (const url of ["/api/auth/guest", "/api/auth/guest-login"]) {
        const res = await app.inject({
          method: "POST",
          url,
          payload: { phone: "9876500001", name: "Mallory Attacker" },
        });
        expect(res.statusCode).toBe(404);
      }
    });

    it("should reject guest session access to patient portal EHR records and personal profile", async () => {
      const guestRes = await app.inject({
        method: "POST",
        url: "/api/public/booking-session",
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
        url: "/api/public/booking-session",
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
  describe("1b. Appointment Object Scope and State Transitions", () => {
    let unrelatedPatientCookie: string;
    let appointment: any;

    beforeAll(async () => {
      const unrelatedPatient = await User.create({
        name: "Unrelated Patient",
        email: `unrelated-${Date.now()}@patient.test`,
        role: "patient",
      });
      const accessToken = generateAccessToken({
        id: unrelatedPatient._id.toString(),
        email: unrelatedPatient.email!,
        role: "patient",
      });
      const refreshToken = await createRefreshToken(unrelatedPatient._id.toString());
      unrelatedPatientCookie = `access_token=${accessToken}; refresh_token=${refreshToken}`;

      appointment = await Appointment.create({
        organizationId: orgId,
        clinicId,
        doctorId: doctorUser._id,
        patientId: testPatient._id,
        bookedByUserId: testPatientUser._id,
        appointmentTime: new Date(),
        appointmentType: "walk-in",
        status: "confirmed",
        tokenNumber: 100,
      });
    });

    it("blocks a patient from reading or mutating another patient's appointment by ID", async () => {
      const detailRes = await app.inject({
        method: "GET",
        url: `/api/appointments/${appointment._id}`,
        headers: { cookie: unrelatedPatientCookie },
      });
      expect(detailRes.statusCode).toBe(403);

      const statusRes = await app.inject({
        method: "PUT",
        url: `/api/appointments/${appointment._id}/status`,
        headers: { cookie: unrelatedPatientCookie },
        payload: { status: "cancelled" },
      });
      expect(statusRes.statusCode).toBe(403);

      const cancelRes = await app.inject({
        method: "PUT",
        url: `/api/appointments/${appointment._id}/cancel`,
        headers: { cookie: unrelatedPatientCookie },
        payload: { reason: "Not my appointment" },
      });
      expect(cancelRes.statusCode).toBe(403);

      const checkInRes = await app.inject({
        method: "POST",
        url: `/api/appointments/${appointment._id}/check-in`,
        headers: { cookie: unrelatedPatientCookie },
      });
      expect(checkInRes.statusCode).toBe(403);

      const queueRes = await app.inject({
        method: "GET",
        url: `/api/queue?clinicId=${clinicId}&doctorId=${doctorUser._id}`,
        headers: { cookie: unrelatedPatientCookie },
      });
      expect(queueRes.statusCode).toBe(403);

      const unchanged = await Appointment.findById(appointment._id);
      expect(unchanged?.status).toBe("confirmed");
    });

    it("rejects invalid and backward status changes", async () => {
      const skipCheckIn = await app.inject({
        method: "PUT",
        url: `/api/appointments/${appointment._id}/status`,
        headers: { cookie: doctorCookie },
        payload: { status: "in-consultation" },
      });
      expect(skipCheckIn.statusCode).toBe(409);

      const checkIn = await app.inject({
        method: "PUT",
        url: `/api/appointments/${appointment._id}/status`,
        headers: { cookie: doctorCookie },
        payload: { status: "checked-in" },
      });
      expect(checkIn.statusCode).toBe(200);

      const backward = await app.inject({
        method: "PUT",
        url: `/api/appointments/${appointment._id}/status`,
        headers: { cookie: doctorCookie },
        payload: { status: "confirmed" },
      });
      expect(backward.statusCode).toBe(409);
    });

    it("requires a tracker-bound, short-lived single-use capability for public check-in", async () => {
      const originalEnforcement = process.env.ENFORCE_TRACKER_CAPABILITIES;
      process.env.ENFORCE_TRACKER_CAPABILITIES = "true";
      try {
        const tracker = createTrackerCapability();
        const publicAppointment = await Appointment.create({
          organizationId: orgId,
          clinicId,
          doctorId: doctorUser._id,
          patientId: testPatient._id,
          bookedByUserId: testPatientUser._id,
          appointmentTime: new Date(),
          appointmentType: "online",
          status: "confirmed",
          tokenNumber: 104,
          trackerTokenHash: tracker.hash,
          trackerTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
        const trackerHeaders = { "x-tracker-token": tracker.token };

        const missingRes = await app.inject({
          method: "POST",
          url: `/api/public/track/${publicAppointment._id}/check-in`,
          headers: trackerHeaders,
        });
        expect(missingRes.statusCode).toBe(401);

        const capabilityRes = await app.inject({
          method: "POST",
          url: `/api/public/track/${publicAppointment._id}/check-in-capability`,
          headers: trackerHeaders,
        });
        expect(capabilityRes.statusCode).toBe(200);
        const checkInToken = JSON.parse(capabilityRes.body).data.checkInToken;

        const checkInRes = await app.inject({
          method: "POST",
          url: `/api/public/track/${publicAppointment._id}/check-in`,
          headers: trackerHeaders,
          payload: { checkInToken },
        });
        expect(checkInRes.statusCode).toBe(200);

        const replayRes = await app.inject({
          method: "POST",
          url: `/api/public/track/${publicAppointment._id}/check-in`,
          headers: trackerHeaders,
          payload: { checkInToken },
        });
        expect(replayRes.statusCode).toBe(401);
        expect((await Appointment.findById(publicAppointment._id))?.status).toBe("checked-in");
      } finally {
        if (originalEnforcement === undefined) delete process.env.ENFORCE_TRACKER_CAPABILITIES;
        else process.env.ENFORCE_TRACKER_CAPABILITIES = originalEnforcement;
      }
    });
  });

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

    it("settles only the exact server-created order once and rejects an amount-tampered callback", async () => {
      const appointment = await Appointment.create({
        organizationId: orgId,
        clinicId,
        doctorId: doctorUser._id,
        patientId: testPatient._id,
        bookedByUserId: testPatientUser._id,
        appointmentTime: new Date(),
        appointmentType: "online",
        status: "pending_payment",
        tokenNumber: 102,
        paymentAmount: 500,
      });
      const invoice = await Invoice.create({
        invoiceNumber: `INV-WEBHOOK-${Date.now()}`,
        organizationId: orgId,
        patientId: testPatient._id,
        appointmentId: appointment._id,
        clinicId,
        doctorId: doctorUser._id,
        items: [{ description: "Consultation Fee", quantity: 1, amount: 500, totalItemAmount: 500 }],
        subtotal: 500,
        totalAmount: 500,
        amountPaid: 0,
        balanceDue: 500,
        status: "unpaid",
      });
      const orderId = `order_webhook_${Date.now()}`;
      await AppointmentPayment.create({
        appointmentId: appointment._id,
        invoiceId: invoice._id,
        patientId: testPatient._id,
        amount: 500,
        paymentMethod: "razorpay",
        razorpayOrderId: orderId,
        status: "created",
        idempotencyKey: `webhook_order_${appointment._id}`,
      });

      const signedRequest = (amount: number) => {
        const payload = {
          transactionId: "pay_webhook_exact_001",
          orderId,
          appointmentId: appointment._id.toString(),
          invoiceId: invoice._id.toString(),
          amount,
          status: "captured",
          paymentMethod: "upi" as const,
        };
        return {
          payload,
          headers: {
            "x-webhook-signature": crypto.createHmac("sha256", UPI_SECRET).update(JSON.stringify(payload)).digest("hex"),
            "content-type": "application/json",
          },
        };
      };

      const tampered = signedRequest(1);
      const tamperedRes = await app.inject({ method: "POST", url: "/api/webhooks/upi", ...tampered });
      expect(tamperedRes.statusCode).toBe(409);
      expect((await Invoice.findById(invoice._id))?.status).toBe("unpaid");

      const correct = signedRequest(500);
      const settledRes = await app.inject({ method: "POST", url: "/api/webhooks/upi", ...correct });
      expect(settledRes.statusCode).toBe(200);
      expect(JSON.parse(settledRes.body).data.replayed).toBe(false);

      const replayRes = await app.inject({ method: "POST", url: "/api/webhooks/upi", ...correct });
      expect(replayRes.statusCode).toBe(200);
      expect(JSON.parse(replayRes.body).data.replayed).toBe(true);

      const settledInvoice = await Invoice.findById(invoice._id);
      const settledPayment = await AppointmentPayment.findOne({ razorpayOrderId: orderId });
      expect(settledInvoice?.status).toBe("paid");
      expect(settledInvoice?.payments).toHaveLength(1);
      expect(settledPayment?.status).toBe("captured");
      expect(settledPayment?.razorpayPaymentId).toBe("pay_webhook_exact_001");
      const receiptMessages = await OutboundMessage.find({
        idempotencyKey: "payment-receipt:pay_webhook_exact_001",
      });
      expect(receiptMessages).toHaveLength(1);
      expect(receiptMessages[0].status).toBe("pending");
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

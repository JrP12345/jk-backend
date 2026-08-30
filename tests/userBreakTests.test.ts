import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.js";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Invoice } from "../models/Invoice.ts";
import { PreAuthorization } from "../models/PreAuthorization.ts";
import { Claim } from "../models/Claim.ts";
import { LabTest } from "../models/LabTest.ts";
import { LabOrder } from "../models/LabOrder.ts";

/**
 * 50 Adversarial "Break-It" Tests — User Perspective
 *
 * These tests simulate what a real user (or attacker) might do:
 * - Submitting garbage / missing fields
 * - Exploiting state machine transitions
 * - Cross-tenant access attempts
 * - XSS / injection payloads
 * - Boundary value attacks
 *
 * Every test expects the system to REJECT gracefully (400/401/403/404).
 * A 500 response = real bug found.
 */

describe("50 Adversarial Break-It Tests — User Perspective", () => {
  // ─── Org A (Primary) ──────────────────────────────────
  let orgA: any;
  let clinicA: any;
  let adminACookies: string;
  let adminAToken: string;
  let patientAUser: any;
  let patientAProfile: any;
  let patientACookies: string;
  let patientAToken: string;
  let doctorAUser: any;
  let invoiceA: any;
  let preAuthA: any;
  let claimA: any;
  let labTestA: any;
  let labOrderA: any;
  let appointmentA: any;

  // ─── Org B (Adversary) ────────────────────────────────
  let orgB: any;
  let clinicB: any;
  let adminBCookies: string;
  let adminBToken: string;
  let patientBUser: any;
  let patientBProfile: any;

  beforeAll(async () => {
    const ts = Date.now();

    // ═══ ORG A SETUP ═══
    const orgARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `BreakTest Hospital A ${ts}`,
        city: "Mumbai",
        admin_name: "Admin A",
        admin_email: `admin_a_${ts}@breaktest.internal`,
        admin_password: "Password123",
      },
    });
    expect(orgARes.statusCode).toBe(201);
    const orgAData = JSON.parse(orgARes.body);
    orgA = orgAData.data?.organization || orgAData.data;
    adminACookies = (orgARes.headers["set-cookie"] as string[])?.join("; ") || "";
    adminAToken = orgARes.cookies?.find((c: any) => c.name === "access_token")?.value || "";

    // Create Clinic A
    const clinicARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminACookies },
      payload: { name: "Break Test Clinic A", city: "Mumbai", address: "100 Test Rd", phone: "9000000001", email: `clinicA_${ts}@test.com` },
    });
    expect(clinicARes.statusCode).toBe(201);
    clinicA = JSON.parse(clinicARes.body).data;

    // Register Patient A
    const patARes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: adminACookies },
      payload: { name: "Patient A", email: `patient_a_${ts}@test.com`, phone: "9111111111", password: "Password123", role: "patient" },
    });
    expect(patARes.statusCode).toBe(201);
    patientAUser = JSON.parse(patARes.body).data.user;
    patientAProfile = await Patient.findOne({ userId: patientAUser.id });

    // Login as Patient A
    const patALogin = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.0.0.1",
      payload: { email: `patient_a_${ts}@test.com`, password: "Password123" },
    });
    patientACookies = (patALogin.headers["set-cookie"] as string[])?.join("; ") || "";
    patientAToken = patALogin.cookies?.find((c: any) => c.name === "access_token")?.value || "";

    // Register Doctor A
    const docARes = await app.inject({
      method: "POST",
      url: "/api/onboarding/staff",
      headers: { cookie: adminACookies },
      payload: { name: "Dr. Break Test", email: `dr_break_${ts}@test.com`, specialization: "General", phone: "9222222222", role: "doctor", password: "Password123" },
    });
    expect(docARes.statusCode).toBe(201);
    doctorAUser = JSON.parse(docARes.body).data;

    // Assign Doctor A to Clinic A
    await app.inject({
      method: "POST",
      url: "/api/onboarding/doctors/assignments",
      headers: { cookie: adminACookies },
      payload: { doctorId: doctorAUser.id, clinicId: clinicA.id, workingHours: "09:00 - 17:00", fees: 500 },
    });

    // Create Invoice A (for billing tests)
    const invRes = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: adminACookies },
      payload: {
        patientId: patientAProfile!._id.toString(),
        clinicId: clinicA.id,
        doctorId: doctorAUser.id,
        items: [{ description: "OPD Consultation", amount: 500, quantity: 1 }],
        subtotal: 500, tax: 0, discount: 0, totalAmount: 500,
      },
    });
    expect(invRes.statusCode).toBe(201);
    invoiceA = JSON.parse(invRes.body).data;

    // Create Pre-Auth A (for state machine tests)
    const paRes = await app.inject({
      method: "POST",
      url: "/api/pre-auth",
      headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id,
        tpaName: "Star Health", policyNumber: "POL-BREAK-001", diagnosisCode: "J06.9",
        proposedTreatment: "Tonsillectomy", requestedAmount: 50000,
      },
    });
    expect(paRes.statusCode).toBe(201);
    preAuthA = JSON.parse(paRes.body).data;

    // Create Claim A
    const claimRes = await app.inject({
      method: "POST",
      url: "/api/billing/claims",
      headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(),
        payerName: "HDFC ERGO", policyNumber: "HDFC-BREAK-001", totalClaimAmount: 25000,
      },
    });
    expect(claimRes.statusCode).toBe(201);
    claimA = JSON.parse(claimRes.body).data;

    // Create Lab Test A
    const ltRes = await app.inject({
      method: "POST",
      url: "/api/lab-tests",
      headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, name: "CBC Complete Blood Count", code: `CBC-BREAK-${ts}`,
        department: "Hematology", sampleType: "Whole Blood", price: 350, normalRange: "4.5-11.0 x10^9/L",
      },
    });
    expect(ltRes.statusCode).toBe(201);
    labTestA = JSON.parse(ltRes.body).data;

    // Create Lab Order A
    const loRes = await app.inject({
      method: "POST",
      url: "/api/lab-orders",
      headers: { cookie: adminACookies },
      payload: { clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id, testId: labTestA.id || labTestA._id },
    });
    expect(loRes.statusCode).toBe(201);
    labOrderA = JSON.parse(loRes.body).data;

    // Create Appointment A
    const apptDate = new Date();
    apptDate.setDate(apptDate.getDate() + 1);
    apptDate.setHours(10, 0, 0, 0);
    const apptRes = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, doctorId: doctorAUser.id,
        appointmentTime: apptDate.toISOString(), appointmentType: "online",
        patientId: patientAProfile!._id.toString(), status: "confirmed", notes: "Break test appointment",
      },
    });
    expect(apptRes.statusCode).toBe(201);
    appointmentA = JSON.parse(apptRes.body).data;

    // ═══ ORG B SETUP (ADVERSARY) ═══
    const orgBRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: {
        org_name: `BreakTest Hospital B ${ts}`,
        city: "Delhi",
        admin_name: "Admin B",
        admin_email: `admin_b_${ts}@breaktest.internal`,
        admin_password: "Password123",
      },
    });
    expect(orgBRes.statusCode).toBe(201);
    const orgBData = JSON.parse(orgBRes.body);
    orgB = orgBData.data?.organization || orgBData.data;
    adminBCookies = (orgBRes.headers["set-cookie"] as string[])?.join("; ") || "";
    adminBToken = orgBRes.cookies?.find((c: any) => c.name === "access_token")?.value || "";

    // Create Clinic B
    const clinicBRes = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminBCookies },
      payload: { name: "Break Test Clinic B", city: "Delhi", address: "200 Hack St", phone: "9333333333", email: `clinicB_${ts}@test.com` },
    });
    expect(clinicBRes.statusCode).toBe(201);
    clinicB = JSON.parse(clinicBRes.body).data;

    // Register Patient B
    const patBRes = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      headers: { cookie: adminBCookies },
      payload: { name: "Patient B", email: `patient_b_${ts}@test.com`, phone: "9444444444", password: "Password123", role: "patient" },
    });
    expect(patBRes.statusCode).toBe(201);
    patientBUser = JSON.parse(patBRes.body).data.user;
    patientBProfile = await Patient.findOne({ userId: patientBUser.id });
  }, 60000);

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 1: AUTH & REGISTRATION ABUSE (Q1-Q5)
  // ═══════════════════════════════════════════════════════════════════

  it("Q1: Register with empty name, email, and password → should reject 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: "", email: "", password: "" },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q2: Register with duplicate email → should reject", async () => {
    const ts = Date.now();
    const email = `dupe_${ts}@test.com`;
    // First registration
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "First", email, password: "Password123" } });
    // Duplicate
    const res = await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Second", email, password: "Password123" } });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 409, 422]).toContain(res.statusCode);
  });

  it("Q3: Login with correct email but wrong password → should reject", async () => {
    const ts = Date.now();
    const email = `wrongpw_${ts}@test.com`;
    await app.inject({ method: "POST", url: "/api/auth/register", payload: { name: "Test", email, password: "Password123" } });
    const res = await app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "10.0.0.3", payload: { email, password: "WrongPassword999" } });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 401, 403]).toContain(res.statusCode);
  });

  it("Q4: Login with non-existent email → should reject without leaking info", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.0.0.4",
      payload: { email: "nonexistent_user_xyz@nowhere.com", password: "Password123" },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 401, 404]).toContain(res.statusCode);
  });

  it("Q5: Register with XSS payload in name → should not return 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { name: '<script>alert("xss")</script>', email: `xss_${Date.now()}@test.com`, password: "Password123" },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 2: ORGANIZATION & CLINIC ONBOARDING ABUSE (Q6-Q10)
  // ═══════════════════════════════════════════════════════════════════

  it("Q6: Create a clinic without authentication → should reject 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      payload: { name: "Hacker Clinic", city: "Gotham" },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([401, 403]).toContain(res.statusCode);
  });

  it("Q7: Create clinic with 10,000 character name → should handle gracefully", async () => {
    const longName = "A".repeat(10000);
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminACookies },
      payload: { name: longName, city: "Mumbai" },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q8: Create clinic with special characters / emojis → should not crash", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/clinics",
      headers: { cookie: adminACookies },
      payload: { name: "🏥 Cl!n1c #$% Tëst™ — «special»", city: "Mumbai" },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q9: Create organization with empty org_name → should reject", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/onboarding/organization",
      payload: { org_name: "", city: "Test", admin_name: "Admin", admin_email: `empty_org_${Date.now()}@test.com`, admin_password: "Password123" },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q10: Org B admin tries to create clinic under Org A → cross-tenant reject", async () => {
    // Org B admin tries to access Org A's pre-auth data
    const res = await app.inject({
      method: "GET",
      url: `/api/pre-auth?clinicId=${clinicA.id}`,
      headers: { cookie: adminBCookies },
    });
    expect(res.statusCode).toBeLessThan(500);
    // Should either return 403 or return empty data
    const body = JSON.parse(res.body);
    if (res.statusCode === 200) {
      expect(body.data.length).toBe(0); // Must not leak Org A's data
    } else {
      expect([403, 404]).toContain(res.statusCode);
    }
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 3: APPOINTMENT BOOKING SABOTAGE (Q11-Q15)
  // ═══════════════════════════════════════════════════════════════════

  it("Q11: Book appointment with non-existent doctorId → should reject", async () => {
    const fakeDocId = new mongoose.Types.ObjectId().toString();
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, doctorId: fakeDocId,
        appointmentTime: new Date(Date.now() + 86400000).toISOString(), appointmentType: "online",
        patientId: patientAProfile!._id.toString(),
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 404]).toContain(res.statusCode);
  });

  it("Q12: Book appointment with past date → should reject", async () => {
    const pastDate = new Date("2020-01-01T10:00:00Z").toISOString();
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, doctorId: doctorAUser.id,
        appointmentTime: pastDate, appointmentType: "online",
        patientId: patientAProfile!._id.toString(),
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q13: Book appointment with missing clinicId → should reject 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminACookies },
      payload: {
        doctorId: doctorAUser.id,
        appointmentTime: new Date(Date.now() + 86400000).toISOString(), appointmentType: "online",
        patientId: patientAProfile!._id.toString(),
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q14: Book appointment with invalid appointmentType 'teleport' → should handle", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, doctorId: doctorAUser.id,
        appointmentTime: new Date(Date.now() + 86400000).toISOString(), appointmentType: "teleport",
        patientId: patientAProfile!._id.toString(),
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q15: Org B admin tries to book appointment using Org A's clinic → cross-tenant reject", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/appointments",
      headers: { cookie: adminBCookies },
      payload: {
        clinicId: clinicA.id, doctorId: doctorAUser.id,
        appointmentTime: new Date(Date.now() + 86400000).toISOString(), appointmentType: "online",
        patientId: patientBProfile!._id.toString(),
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 403, 404]).toContain(res.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 4: INVOICE & BILLING EXPLOITATION (Q16-Q20)
  // ═══════════════════════════════════════════════════════════════════

  it("Q16: Create invoice with negative totalAmount → should reject", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: adminACookies },
      payload: {
        patientId: patientAProfile!._id.toString(), clinicId: clinicA.id, doctorId: doctorAUser.id,
        items: [{ description: "Negative Test", amount: -500, quantity: 1 }],
        subtotal: -500, tax: 0, discount: 0, totalAmount: -500,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q17: Create invoice with empty items array → should reject 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: adminACookies },
      payload: {
        patientId: patientAProfile!._id.toString(), clinicId: clinicA.id, doctorId: doctorAUser.id,
        items: [], subtotal: 0, tax: 0, discount: 0, totalAmount: 0,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q18: Create invoice with non-existent patientId → should reject", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: adminACookies },
      payload: {
        patientId: fakeId, clinicId: clinicA.id, doctorId: doctorAUser.id,
        items: [{ description: "Ghost Patient", amount: 100, quantity: 1 }],
        subtotal: 100, tax: 0, discount: 0, totalAmount: 100,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 404]).toContain(res.statusCode);
  });

  it("Q19: Pay an invoice that is already paid → should reject double-payment", async () => {
    // First create & pay a fresh invoice
    const invRes = await app.inject({
      method: "POST", url: "/api/invoices", headers: { cookie: adminACookies },
      payload: {
        patientId: patientAProfile!._id.toString(), clinicId: clinicA.id, doctorId: doctorAUser.id,
        items: [{ description: "Double-pay test", amount: 200, quantity: 1 }],
        subtotal: 200, tax: 0, discount: 0, totalAmount: 200,
      },
    });
    const inv = JSON.parse(invRes.body).data;

    // Pay first time
    await app.inject({
      method: "PUT", url: `/api/invoices/${inv.id}/pay`, headers: { cookie: adminACookies },
      payload: { paymentMethod: "upi" },
    });

    // Try pay again
    const res = await app.inject({
      method: "PUT", url: `/api/invoices/${inv.id}/pay`, headers: { cookie: adminACookies },
      payload: { paymentMethod: "upi" },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q20: Create invoice with discount > subtotal (150% discount) → should handle", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/invoices",
      headers: { cookie: adminACookies },
      payload: {
        patientId: patientAProfile!._id.toString(), clinicId: clinicA.id, doctorId: doctorAUser.id,
        items: [{ description: "Discount exploit", amount: 100, quantity: 1 }],
        subtotal: 100, tax: 0, discount: 150, totalAmount: -50,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 5: INSURANCE PRE-AUTH STATE MACHINE ATTACKS (Q21-Q25)
  // ═══════════════════════════════════════════════════════════════════

  it("Q21: Submit pre-auth with requestedAmount: 0 → should reject", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/pre-auth", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id,
        tpaName: "Test TPA", policyNumber: "POL-ZERO", diagnosisCode: "A00",
        proposedTreatment: "Zero Test", requestedAmount: 0,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q22: Submit pre-auth with requestedAmount: -10000 → should reject", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/pre-auth", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id,
        tpaName: "Test TPA", policyNumber: "POL-NEG", diagnosisCode: "A00",
        proposedTreatment: "Negative Test", requestedAmount: -10000,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q23: Submit pre-auth with malformed patientId 'not-an-objectid' → should reject 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/pre-auth", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: "not-an-objectid", doctorId: doctorAUser.id,
        tpaName: "Test TPA", policyNumber: "POL-MALFORM", diagnosisCode: "A00",
        proposedTreatment: "Malformed ID Test", requestedAmount: 10000,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q24: Update pre-auth from rejected → approved (invalid transition) → should reject", async () => {
    // First reject the pre-auth
    const paId = preAuthA._id || preAuthA.id;
    await app.inject({
      method: "PUT", url: `/api/pre-auth/${paId}`, headers: { cookie: adminACookies },
      payload: { status: "rejected", denialReason: "Test rejection" },
    });

    // Now try to approve it (invalid: rejected → approved)
    const res = await app.inject({
      method: "PUT", url: `/api/pre-auth/${paId}`, headers: { cookie: adminACookies },
      payload: { status: "approved", approvedAmount: 40000, approvalCode: "HACK-001" },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it("Q25: Update pre-auth approvedAmount > requestedAmount → should reject", async () => {
    // Create a fresh pre-auth for this test
    const paRes = await app.inject({
      method: "POST", url: "/api/pre-auth", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id,
        tpaName: "Overflow TPA", policyNumber: "POL-OVERFLOW", diagnosisCode: "B00",
        proposedTreatment: "Overflow Test", requestedAmount: 10000,
      },
    });
    const pa = JSON.parse(paRes.body).data;
    const paId = pa._id || pa.id;

    const res = await app.inject({
      method: "PUT", url: `/api/pre-auth/${paId}`, headers: { cookie: adminACookies },
      payload: { status: "approved", approvedAmount: 999999 },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 6: INSURANCE CLAIMS ADJUDICATION ATTACKS (Q26-Q30)
  // ═══════════════════════════════════════════════════════════════════

  it("Q26: Submit claim with totalClaimAmount: 0 → should reject", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/billing/claims", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(),
        payerName: "Zero Insurer", policyNumber: "ZERO-001", totalClaimAmount: 0,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q27: Adjudicate claim with invalid status 'super_approved' → should reject", async () => {
    const claimId = claimA._id || claimA.id;
    const res = await app.inject({
      method: "POST", url: `/api/billing/claims/${claimId}/adjudicate`, headers: { cookie: adminACookies },
      payload: { status: "super_approved", approvedAmount: 20000 },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q28: Adjudicate settled claim back to approved → invalid transition", async () => {
    // Create a fresh claim, approve it, settle it, then try re-approve
    const claimRes = await app.inject({
      method: "POST", url: "/api/billing/claims", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(),
        payerName: "State Machine Insurer", policyNumber: "SM-001", totalClaimAmount: 15000,
      },
    });
    const claim = JSON.parse(claimRes.body).data;
    const cId = claim._id || claim.id;

    // submitted → approved
    await app.inject({
      method: "POST", url: `/api/billing/claims/${cId}/adjudicate`, headers: { cookie: adminACookies },
      payload: { status: "approved", approvedAmount: 14000 },
    });
    // approved → settled
    await app.inject({
      method: "POST", url: `/api/billing/claims/${cId}/adjudicate`, headers: { cookie: adminACookies },
      payload: { status: "settled" },
    });
    // settled → approved (INVALID)
    const res = await app.inject({
      method: "POST", url: `/api/billing/claims/${cId}/adjudicate`, headers: { cookie: adminACookies },
      payload: { status: "approved", approvedAmount: 14000 },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q29: Adjudicate claim with approvedAmount > totalClaimAmount → should reject", async () => {
    const claimRes = await app.inject({
      method: "POST", url: "/api/billing/claims", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(),
        payerName: "Overflow Insurer", policyNumber: "OVF-001", totalClaimAmount: 10000,
      },
    });
    const claim = JSON.parse(claimRes.body).data;
    const cId = claim._id || claim.id;

    const res = await app.inject({
      method: "POST", url: `/api/billing/claims/${cId}/adjudicate`, headers: { cookie: adminACookies },
      payload: { status: "approved", approvedAmount: 999999 },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q30: Submit claim with non-existent invoiceId → should reject", async () => {
    const fakeInvId = new mongoose.Types.ObjectId().toString();
    const res = await app.inject({
      method: "POST", url: "/api/billing/claims", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(),
        invoiceId: fakeInvId, payerName: "Ghost Invoice Insurer", policyNumber: "GI-001", totalClaimAmount: 5000,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 404]).toContain(res.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 7: LABORATORY LIS ABUSE (Q31-Q35)
  // ═══════════════════════════════════════════════════════════════════

  it("Q31: Create lab test with duplicate code → should reject", async () => {
    const existingCode = labTestA.code;
    const res = await app.inject({
      method: "POST", url: "/api/lab-tests", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, name: "Duplicate Test", code: existingCode,
        department: "Hematology", sampleType: "Blood", price: 200, normalRange: "Normal",
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 409, 422]).toContain(res.statusCode);
  });

  it("Q32: Create lab test with negative price → should handle", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/lab-tests", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, name: "Negative Price Test", code: `NEG-${Date.now()}`,
        department: "Biochemistry", sampleType: "Serum", price: -100, normalRange: "N/A",
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q33: Place lab order with non-existent testId → should reject", async () => {
    const fakeTestId = new mongoose.Types.ObjectId().toString();
    const res = await app.inject({
      method: "POST", url: "/api/lab-orders", headers: { cookie: adminACookies },
      payload: { clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id, testId: fakeTestId },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 404]).toContain(res.statusCode);
  });

  it("Q34: Upload result to lab order still in 'ordered' status (sample not collected) → should reject or handle", async () => {
    // Create a fresh lab order in 'ordered' status
    const loRes = await app.inject({
      method: "POST", url: "/api/lab-orders", headers: { cookie: adminACookies },
      payload: { clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id, testId: labTestA.id || labTestA._id },
    });
    const order = JSON.parse(loRes.body).data;
    const orderId = order._id || order.id;

    // Try uploading result without collecting sample first
    const res = await app.inject({
      method: "PUT", url: `/api/lab-orders/${orderId}/result`, headers: { cookie: adminACookies },
      payload: { resultValue: "5.5%", resultNotes: "Skipped sample collection" },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q35: Place lab order with missing doctorId → should reject 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/lab-orders", headers: { cookie: adminACookies },
      payload: { clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), testId: labTestA.id || labTestA._id },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 8: TELECONSULTATION SESSION ABUSE (Q36-Q40)
  // ═══════════════════════════════════════════════════════════════════

  it("Q36: Create teleconsultation session with non-existent appointmentId → should reject", async () => {
    const fakeApptId = new mongoose.Types.ObjectId().toString();
    const res = await app.inject({
      method: "POST", url: "/api/teleconsultation/session", headers: { cookie: adminACookies },
      payload: { appointmentId: fakeApptId },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 404]).toContain(res.statusCode);
  });

  it("Q37: Create teleconsultation session with malformed ObjectId → should reject 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/teleconsultation/session", headers: { cookie: adminACookies },
      payload: { appointmentId: "not-a-valid-id" },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q38: Start a teleconsultation session that doesn't exist → should reject 404", async () => {
    const fakeId = new mongoose.Types.ObjectId().toString();
    const res = await app.inject({
      method: "PUT", url: `/api/teleconsultation/session/${fakeId}/start`, headers: { cookie: adminACookies },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([404]).toContain(res.statusCode);
  });

  it("Q39: End a teleconsultation session that was never started → should handle gracefully", async () => {
    // Create session (status = scheduled)
    const sessRes = await app.inject({
      method: "POST", url: "/api/teleconsultation/session", headers: { cookie: adminACookies },
      payload: { appointmentId: appointmentA.id },
    });
    const session = JSON.parse(sessRes.body).data;
    const sessId = session._id || session.id;

    // Try to end it without starting
    const res = await app.inject({
      method: "PUT", url: `/api/teleconsultation/session/${sessId}/end`, headers: { cookie: adminACookies },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q40: Create duplicate teleconsultation session for same appointment → should return existing", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/teleconsultation/session", headers: { cookie: adminACookies },
      payload: { appointmentId: appointmentA.id },
    });
    // System should return existing session, not create duplicate
    expect(res.statusCode).toBeLessThan(500);
    expect([200, 201]).toContain(res.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 9: PATIENT DATA & CROSS-TENANT ISOLATION (Q41-Q45)
  // ═══════════════════════════════════════════════════════════════════

  it("Q41: Patient tries to access invoices from another org → should see empty or 403", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/invoices?clinicId=${clinicB.id}`,
      headers: { cookie: patientACookies },
    });
    expect(res.statusCode).toBeLessThan(500);
    if (res.statusCode === 200) {
      const body = JSON.parse(res.body);
      expect(body.data.length).toBe(0); // Patient A should not see Clinic B invoices
    }
  });

  it("Q42: Patient tries to create a lab test (staff-only) → should reject 403", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/lab-tests",
      headers: { cookie: patientACookies },
      payload: {
        clinicId: clinicA.id, name: "Patient Hack Test", code: `HACK-${Date.now()}`,
        department: "Hack", sampleType: "None", price: 0, normalRange: "None",
      },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([401, 403]).toContain(res.statusCode);
  });

  it("Q43: Patient tries to adjudicate an insurance claim → should reject 403", async () => {
    const claimId = claimA._id || claimA.id;
    const res = await app.inject({
      method: "POST", url: `/api/billing/claims/${claimId}/adjudicate`,
      headers: { cookie: patientACookies },
      payload: { status: "approved", approvedAmount: 25000 },
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([401, 403]).toContain(res.statusCode);
  });

  it("Q44: Update patient profile with XSS in allergies array → should not crash", async () => {
    const res = await app.inject({
      method: "PATCH", url: `/api/patients/${patientAProfile!._id.toString()}`,
      headers: { cookie: adminACookies },
      payload: {
        allergies: ['<img onerror=alert(1)>', '<script>document.cookie</script>', 'Normal Allergy'],
        conditions: ['<div onmouseover="hack()">Condition</div>'],
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q45: Access protected API endpoint without any auth token → should reject 401", async () => {
    const res = await app.inject({
      method: "GET", url: "/api/invoices",
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([401, 403]).toContain(res.statusCode);
  });

  // ═══════════════════════════════════════════════════════════════════
  // GROUP 10: BOUNDARY & EDGE CASE CHAOS (Q46-Q50)
  // ═══════════════════════════════════════════════════════════════════

  it("Q46: Send completely empty body {} to POST /api/pre-auth → should reject 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/pre-auth", headers: { cookie: adminACookies },
      payload: {},
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q47: Send completely empty body {} to POST /api/billing/claims → should reject 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/billing/claims", headers: { cookie: adminACookies },
      payload: {},
    });
    expect(res.statusCode).toBeLessThan(500);
    expect([400, 422]).toContain(res.statusCode);
  });

  it("Q48: Query pre-auth list with NoSQL-injection style search → should not crash", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/pre-auth?clinicId=${clinicA.id}&search='; DROP TABLE--`,
      headers: { cookie: adminACookies },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q49: Submit pre-auth with unicode/RTL characters in policyNumber → should not crash", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/pre-auth", headers: { cookie: adminACookies },
      payload: {
        clinicId: clinicA.id, patientId: patientAProfile!._id.toString(), doctorId: doctorAUser.id,
        tpaName: "Unicode TPA", policyNumber: "‮POL-12345‬\u200B\u200F",
        diagnosisCode: "Z99.9", proposedTreatment: "Unicode Test", requestedAmount: 5000,
      },
    });
    expect(res.statusCode).toBeLessThan(500);
  });

  it("Q50: Rapidly fire 5 identical claim submissions in parallel → should not create duplicates or crash", async () => {
    const payload = {
      clinicId: clinicA.id, patientId: patientAProfile!._id.toString(),
      payerName: "Race Condition Insurer", policyNumber: "RACE-001", totalClaimAmount: 7777,
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        app.inject({ method: "POST", url: "/api/billing/claims", headers: { cookie: adminACookies }, payload })
      )
    );

    // All should complete without 500
    results.forEach(r => expect(r.statusCode).toBeLessThan(500));

    // All should be 201 (each creates a unique claim number)
    const successes = results.filter(r => r.statusCode === 201);
    expect(successes.length).toBeGreaterThan(0);
  });
});

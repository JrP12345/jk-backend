import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import speakeasy from "speakeasy";
import mongoose from "mongoose";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Doctor } from "../models/Doctor.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { SubscriptionPayment } from "../models/SubscriptionPayment.ts";
import { PharmacyOnboardingRequest } from "../models/PharmacyOnboardingRequest.ts";
import { OtpVerification } from "../models/OtpVerification.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Medicine } from "../models/Medicine.ts";
import { Invoice } from "../models/Invoice.ts";
import { Encounter } from "../models/Encounter.ts";
import { otpService } from "../services/OtpService.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";
import { verifyTwoFactorChallenge } from "../utilities/helpers.ts";

const password = "PharmacyOwner123!", codeByEmail = new Map<string, string>(); let ipSequence = 0;
beforeAll(async () => {
  await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  vi.spyOn(emailProvider, "sendEmail").mockResolvedValue(true);
  const request = otpService.requestOtp.bind(otpService);
  vi.spyOn(otpService, "requestOtp").mockImplementation(async (target, purpose, context) => {
    const result = await request(target, purpose, context); const email = typeof target === "string" ? target : target.email;
    if (email && purpose === "business_onboarding" && result.devOtp) codeByEmail.set(email, result.devOtp); return result;
  });
});
afterAll(() => vi.restoreAllMocks());
async function fixture(email = `${crypto.randomUUID()}@example.test`) {
  const plan = await SaaSPlan.create({ name: "Synthetic pharmacy trial", slug: `pharmacy-${crypto.randomUUID()}`, description: "Synthetic public catalogue", commercialFamily: "location_products", legacyTier: "starter", selfServicePharmacy: true, currency: "INR", trialDays: 7,
    limits: { maxLocations: 2, maxDoctors: 2, maxStaff: 5 }, commercialPricing: { revision: 1, monthly: { clinicPaise: 79900, pharmacyPaise: 49900, pharmacyAddonPaise: 29900, extraDoctorPaise: 29900, additionalPharmacyPaise: 49900 }, taxMode: "inclusive", taxRateBps: 1800, includedDoctors: 1, doctorsPerAdditionalClinic: 1 } });
  const ip = `10.72.0.${++ipSequence}`;
  const options = await app.inject({ method: "GET", url: "/api/pharmacy/onboarding/options", remoteAddress: ip });
  const option = options.json().data.items.find((row: any) => row.id === plan.id); expect(option, options.body).toBeDefined();
  const input = { email, ownerName: "Synthetic business owner", password, businessName: `Synthetic pharmacy ${crypto.randomUUID()}`, city: "Pune", address: "Actual synthetic branch address, Pune", planId: plan.id, planFingerprint: option.fingerprint };
  return { plan, option, ip, input };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, stage: string, payload: object, key: string = crypto.randomUUID()) => app.inject({ method: "POST", url: `/api/pharmacy/onboarding/${stage}`, remoteAddress: f.ip, headers: { "idempotency-key": key }, payload });
async function started(f: Fixture) {
  const response = await post(f, "start", f.input); expect(response.statusCode, response.body).toBe(201);
  const { requestId, setupToken } = response.json().data; return { requestId, setupToken };
}
async function verified(f: Fixture) {
  const proof = await started(f); const response = await post(f, "verify", { ...proof, otp: codeByEmail.get(f.input.email) }); expect(response.statusCode, response.body).toBe(200); return proof;
}
const cookies = (response: { cookies: Array<{ name: string; value: string }> }) => response.cookies.filter(row => row.value && ["access_token", "refresh_token"].includes(row.name)).map(row => `${row.name}=${row.value}`).join("; ");
async function enroll(cookie: string) {
  const setup = await app.inject({ method: "POST", url: "/api/onboarding/totp/setup", headers: { cookie } }); expect(setup.statusCode, setup.body).toBe(200);
  const secret = setup.json().data.secret;
  const response = await app.inject({ method: "POST", url: "/api/onboarding/totp/verify", headers: { cookie }, payload: { token: speakeasy.totp({ secret, encoding: "base32" }) } });
  expect(response.statusCode, response.body).toBe(200); return { cookie: cookies(response), secret };
}
describe("Independent verified pharmacy business setup", () => {
  it("reaches a first ordinary sale through owner routes without a platform-created customer or clinical profile", async () => {
    const f = await fixture(), proof = await verified(f), completed = await post(f, "complete", proof);
    expect(completed.statusCode, completed.body).toBe(200);
    const { organization, locationId } = completed.json().data.onboarding, active = await enroll(cookies(completed));
    const request = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: object) => app.inject({ method, url: `/api${url}`, headers: { cookie: active.cookie, "idempotency-key": crypto.randomUUID() }, ...(payload ? { payload } : {}) });
    const issuer = await request("PUT", `/pharmacy/locations/${locationId}/tax-profile`, { expectedRevision: 0, registration: "unregistered", legalName: f.input.businessName,
      address: f.input.address, stateCode: "27", drugLicenceNumbers: ["SYNTHETIC-TEST-LICENCE"], authorisedSignatory: f.input.ownerName,
      reviewReference: "Synthetic first-sale review, no professional approval", pricesIncludeTax: true, minimumHsnDigits: 4, electronicReportingRequired: false });
    expect(issuer.statusCode, issuer.body).toBe(200);
    const enabled = await request("PATCH", `/pharmacy/locations/${locationId}/settings`, { enabled: true, expectedRevision: 0, reviewReference: "Synthetic activation review" }); expect(enabled.statusCode, enabled.body).toBe(200);
    const capabilities = await request("GET", `/pharmacy/locations/${locationId}/capabilities`); expect(capabilities.statusCode, capabilities.body).toBe(200);
    expect(capabilities.json().data.actions).toMatchObject({ viewRxQueue: false, dispense: false, recoverDispense: false });
    const product = await request("POST", "/medicines", { locationId, name: "Synthetic ordinary product", genericName: "Synthetic generic", category: "tablet", price: 10, stockQuantity: 0, scheduleType: "general", hsnCode: "300490", gstRate: 0,
      unitDefinition: { baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } }); expect(product.statusCode, product.body).toBe(201);
    const medicineId = product.json().data.id || product.json().data._id;
    const tax = await request("PUT", `/pharmacy/medicines/${medicineId}/tax-classification`, { expectedRevision: 0, hsnCode: "300490", unitCode: "NOS", gstRate: 0, treatment: "nil_rated", reviewReference: "Synthetic product tax review" }); expect(tax.statusCode, tax.body).toBe(200);
    const classification = await request("PUT", `/pharmacy/medicines/${medicineId}/dispensing-classification`, { expectedRevision: 0, scheduleType: "general", reviewReference: "Synthetic ordinary classification review" }); expect(classification.statusCode, classification.body).toBe(200);
    const receipt = await request("POST", "/pharmacy/stock-receipts", { locationId, medicineId, kind: "opening", receiptLineId: crypto.randomUUID(), expectedUnitVersion: 1, packs: 1, looseUnits: 0,
      batchNumber: "SYNTHETIC-INITIAL-LOT", expiry: { precision: "month", value: "2099-12" }, purchaseTotalPaise: 101, sellingPricePaise: 1000, mrpPaise: 1200, openingSourceReference: "Synthetic actual opening count" }); expect(receipt.statusCode, receipt.body).toBe(201);
    const input = { locationId, expectedProfileRevision: 1, expectedTotalPaise: 2000, lines: [{ lineId: crypto.randomUUID(), medicineId, quantity: 2, expectedUnitVersion: 1, expectedStockRevision: 1, discountPaise: 0 }] };
    const quote = await request("POST", "/pharmacy/sales/quote", { locationId, lines: input.lines.map(({ expectedStockRevision: _revision, ...line }) => { void _revision; return line; }) }); expect(quote.statusCode, quote.body).toBe(200);
    const sale = await request("POST", "/pharmacy/sales", quote.json().data.issueInput); expect(sale.statusCode, sale.body).toBe(201);
    expect(await Invoice.findById(sale.json().data.invoiceId)).toMatchObject({ kind: "pharmacy", status: "unpaid", totalAmount: 20 });
    expect((await Medicine.findById(medicineId))!.stockQuantity).toBe(8);
    expect(await Patient.countDocuments({ organizationId: organization.id })).toBe(0); expect(await Doctor.countDocuments({ organizationId: organization.id })).toBe(0); expect(await Encounter.countDocuments({ organizationId: organization.id })).toBe(0);
    expect(await SubscriptionPayment.countDocuments({ organizationId: organization.id })).toBe(0);
  });
  it("expires setup proofs and rotates the OTP context without granting a new trial", async () => {
    const f = await fixture(), old = await started(f), oldCode = codeByEmail.get(f.input.email);
    expect((await post(f, "resend", old)).statusCode).toBe(429);
    await PharmacyOnboardingRequest.updateOne({ _id: old.requestId }, { $set: { lastSentAt: new Date(Date.now() - 120000) } });
    const next = await started(f); expect(next.requestId).toBe(old.requestId); expect(next.setupToken).not.toBe(old.setupToken);
    expect((await post(f, "verify", { ...old, otp: oldCode })).statusCode).toBe(401);
    await PharmacyOnboardingRequest.updateOne({ _id: next.requestId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post(f, "verify", { ...next, otp: codeByEmail.get(f.input.email) })).statusCode).toBe(401);
    expect((await post(f, "complete", next)).statusCode).toBe(401); expect(await User.exists({ email: f.input.email })).toBeNull();
  });
  it("rolls back all provisioning when the required audit cannot be written, then resumes the same reference", async () => {
    const f = await fixture(), proof = await verified(f), key = crypto.randomUUID();
    const create = AuditLog.create.bind(AuditLog);
    const fail = vi.spyOn(AuditLog, "create").mockImplementationOnce((...args: any[]) => {
      if (Array.isArray(args[0]) && args[0][0]?.action === "PHARMACY_SELF_SERVICE_PROVISIONED") throw Error("Synthetic audit failure");
      return (create as any)(...args);
    });
    const rejected = await post(f, "complete", proof, key); fail.mockRestore(); expect(rejected.statusCode, rejected.body).toBe(500);
    expect(await Organization.exists({ email: f.input.email })).toBeNull(); expect((await PharmacyOnboardingRequest.findById(proof.requestId))!.state).toBe("verified");
    const retry = await post(f, "complete", proof, key); expect(retry.statusCode, retry.body).toBe(200); expect(await Organization.countDocuments({ email: f.input.email })).toBe(1);
  });
  it("publishes configured trial prices without a purchase token, account or clinical enrollment", async () => {
    const f = await fixture(); expect(f.option).toMatchObject({ monthlyTotalPaise: 49900, currency: "INR", trialDays: 7, maxStaff: 5 }); expect(f.option).not.toHaveProperty("quoteToken");
    expect(await User.exists({ email: f.input.email })).toBeNull(); expect(await Organization.exists({ email: f.input.email })).toBeNull();
    await SaaSPlan.updateOne({ _id: f.plan._id }, { $set: { selfServicePharmacy: false } });
    expect((await post(f, "start", f.input)).statusCode).toBe(409);
  });
  it("keeps the verified provisional identity unprivileged, provisions one pharmacy trial and requires live MFA before operations", async () => {
    const f = await fixture(), proof = await started(f);
    expect(await User.exists({ email: f.input.email })).toBeNull(); expect(await Organization.exists({ email: f.input.email })).toBeNull();
    const response = await post(f, "verify", { ...proof, otp: codeByEmail.get(f.input.email) }); expect(response.statusCode, response.body).toBe(200);
    const applicant = await User.findOne({ email: f.input.email }); expect(applicant).toMatchObject({ role: "pharmacy_applicant", isEmailVerified: true });
    const verifiedClaim = await PharmacyOnboardingRequest.findById(proof.requestId).select("+intentCiphertext");
    expect(JSON.parse(decryptField(verifiedClaim!.intentCiphertext))).not.toHaveProperty("passwordHash");
    expect(await OrgMember.countDocuments({ userId: applicant!._id })).toBe(0); expect(await Patient.countDocuments({ userId: applicant!._id })).toBe(0);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: f.input.email, password } })).statusCode).toBe(403);
    const key = crypto.randomUUID(), completed = await post(f, "complete", proof, key); expect(completed.statusCode, completed.body).toBe(200);
    const data = completed.json().data, organizationId = data.onboarding.organization.id, locationId = data.onboarding.locationId;
    expect(data.user).toMatchObject({ role: "admin", workspaceProfile: "pharmacy", mfaEnrollmentRequired: true, organization_id: organizationId });
    expect(await Organization.findById(organizationId)).toMatchObject({ workspaceProfile: "pharmacy", staffMfaRequired: true, isOnboarded: true, maxDoctors: 0, maxLocations: 1 });
    expect(await Subscription.findOne({ organizationId })).toMatchObject({ status: "trialing", entitlementSource: "trial", commercialQuote: { commercialFamily: "pharmacy", totalPaise: 49900 } });
    const enabled = (await ModuleRegistry.find({ organizationId, enabled: true })).map(row => row.moduleKey);
    expect(enabled).toContain("pharmacy"); expect(enabled).not.toContain("patients"); expect(enabled).not.toContain("consultations"); expect(enabled).not.toContain("appointments");
    expect(await Patient.countDocuments({ organizationId })).toBe(0); expect(await Doctor.countDocuments({ organizationId })).toBe(0); expect(await SubscriptionPayment.countDocuments({ organizationId })).toBe(0);
    const pending = cookies(completed), denied = await app.inject({ method: "GET", url: `/api/pharmacy/locations/${locationId}/capabilities`, headers: { cookie: pending } }); expect(denied.statusCode, denied.body).toBe(403);
    const active = await enroll(pending), me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: active.cookie } }); expect(me.json().data.user).toMatchObject({ role: "admin", mfaEnrollmentRequired: false, workspaceProfile: "pharmacy" });
    const replay = await post(f, "complete", proof, key); expect(replay.statusCode).toBe(200); expect(replay.json().data.twoFactorRequired).toBe(true);
    expect(await Organization.countDocuments({ email: f.input.email })).toBe(1); expect(await Location.countDocuments({ organizationId })).toBe(1); expect(await Subscription.countDocuments({ organizationId })).toBe(1);
    expect(await AuditLog.countDocuments({ organizationId, action: "PHARMACY_SELF_SERVICE_PROVISIONED" })).toBe(1);
  });
  it("commits failed OTP attempts and never treats a business code as patient authentication", async () => {
    const f = await fixture(), proof = await started(f), code = codeByEmail.get(f.input.email)!;
    const bypass = await app.inject({ method: "POST", url: "/api/auth/otp/verify", payload: { email: f.input.email, otp: code, purpose: "business_onboarding" } }); expect(bypass.statusCode).toBe(400);
    for (let index = 0; index < 5; index++) expect((await post(f, "verify", { ...proof, otp: "000000" })).statusCode).toBe(400);
    expect((await OtpVerification.findOne({ email: f.input.email, purpose: "business_onboarding" }))!.attempts).toBe(5);
    expect((await post(f, "verify", { ...proof, otp: code })).statusCode).toBe(400); expect(await User.exists({ email: f.input.email })).toBeNull();
  });
  it("refuses proof mutation, unverified completion and client-supplied roles, quotas or trial duration", async () => {
    const f = await fixture();
    expect((await post(f, "start", { ...f.input, trialDays: 365, maxDoctors: 999, role: "root" })).statusCode).toBe(400);
    const proof = await started(f);
    expect((await post(f, "complete", proof)).statusCode).toBe(403);
    expect((await post(f, "verify", { ...proof, setupToken: "0".repeat(64), otp: codeByEmail.get(f.input.email) })).statusCode).toBe(401);
    expect(await Organization.exists({ email: f.input.email })).toBeNull();
  });
  it("rolls back business creation when published terms change after verification", async () => {
    const f = await fixture(), proof = await verified(f);
    await SaaSPlan.updateOne({ _id: f.plan._id }, { $inc: { "commercialPricing.revision": 1, "commercialPricing.monthly.pharmacyPaise": 100 } });
    expect((await post(f, "complete", proof)).statusCode).toBe(409); expect(await Organization.exists({ email: f.input.email })).toBeNull();
    expect((await User.findOne({ email: f.input.email }))!.role).toBe("pharmacy_applicant");
  });
  it("serializes different completion keys into one business and one trial", async () => {
    const f = await fixture(), proof = await verified(f);
    const results = await Promise.all([post(f, "complete", proof), post(f, "complete", proof)]); for (const result of results) expect(result.statusCode, result.body).toBe(200);
    const ids = results.map(row => row.json().data.onboarding.organization.id); expect(new Set(ids).size).toBe(1);
    expect(await Organization.countDocuments({ email: f.input.email })).toBe(1); expect(await OrgMember.countDocuments({ organizationId: ids[0] })).toBe(1); expect(await Subscription.countDocuments({ organizationId: ids[0] })).toBe(1);
    expect((await post(f, "start", f.input)).statusCode).toBe(409);
  });
  it("preserves an existing patient identity and credentials across scoped staff MFA, refresh and future workspace selection", async () => {
    const email = `${crypto.randomUUID()}@example.test`, originalHash = await bcrypt.hash(password, 4);
    const user = await User.create({ name: "Existing care identity", email, password: originalHash, role: "patient", isEmailVerified: true });
    const clinic = await Organization.create({ name: "Existing patient clinic", city: "Pune" }), patient = await Patient.create({ organizationId: clinic.id, userId: user.id, name: "Original patient record" });
    const f = await fixture(email), proof = await verified(f), completed = await post(f, "complete", proof); expect(completed.statusCode, completed.body).toBe(200);
    const organizationId = completed.json().data.onboarding.organization.id;
    const rotated = await app.inject({ method: "POST", url: "/api/auth/refresh", headers: { cookie: cookies(completed) } }); expect(rotated.statusCode, rotated.body).toBe(200);
    const active = await enroll(cookies(rotated));
    expect(await User.findById(user.id)).toMatchObject({ role: "patient", password: originalHash }); expect(await Patient.findById(patient.id)).toMatchObject({ organizationId: clinic._id, userId: user._id, name: "Original patient record" });
    const personalLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } }); expect(personalLogin.json().data.twoFactorRequired).toBe(true);
    const personal = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: { twoFactorToken: personalLogin.json().data.twoFactorToken, otp: speakeasy.totp({ secret: active.secret, encoding: "base32" }) } });
    expect(personal.statusCode, personal.body).toBe(200); expect(personal.json().data.user).toMatchObject({ role: "patient", hasStaffWorkspaces: true });
    const switched = await app.inject({ method: "POST", url: "/api/auth/switch-org", headers: { cookie: cookies(personal) }, payload: { organizationId } }); expect(switched.statusCode, switched.body).toBe(200);
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookies(switched) } }); expect(me.json().data.user).toMatchObject({ role: "admin", organization_id: organizationId, workspaceProfile: "pharmacy", mfaEnrollmentRequired: false });
  });
  it("binds an existing account's MFA challenge to its newly provisioned business", async () => {
    const email = `${crypto.randomUUID()}@example.test`, secret = "JBSWY3DPEHPK3PXP";
    await User.create({ name: "Verified existing account", email, role: "patient", password: await bcrypt.hash(password, 4), twoFactorEnabled: true, twoFactorSecret: encryptField(secret), isEmailVerified: true });
    const f = await fixture(email), proof = await verified(f), completed = await post(f, "complete", proof);
    expect(completed.statusCode, completed.body).toBe(200); const challenge = completed.json().data.twoFactorToken, bound = verifyTwoFactorChallenge(challenge);
    const claim = await PharmacyOnboardingRequest.findById(proof.requestId); expect(bound.organizationId).toBe(String(claim!.organizationId)); expect(cookies(completed)).toBe("");
    const signedIn = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: { twoFactorToken: challenge, otp: speakeasy.totp({ secret, encoding: "base32" }) } });
    expect(signedIn.statusCode, signedIn.body).toBe(200); expect(signedIn.json().data.user).toMatchObject({ organization_id: bound.organizationId, role: "admin", workspaceProfile: "pharmacy" });
  });
  it("does not claim production email delivery or grant a verified identity when the provider declines", async () => {
    const f = await fixture(); vi.mocked(emailProvider.sendEmail).mockResolvedValueOnce(false); vi.stubEnv("NODE_ENV", "production");
    try {
      const response = await post(f, "start", f.input); expect(response.statusCode, response.body).toBe(201); expect(response.json().data.deliveryAvailable).toBe(false); expect(response.json().data).not.toHaveProperty("devOtp");
      expect(await User.exists({ email: f.input.email })).toBeNull(); expect(await OtpVerification.countDocuments({ email: f.input.email, expiresAt: { $gt: new Date() } })).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });
});

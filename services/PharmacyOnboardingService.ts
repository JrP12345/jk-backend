import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { PharmacyOnboardingRequest } from "../models/PharmacyOnboardingRequest.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Subscription } from "../models/Subscription.ts";
import { Location } from "../models/Location.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { otpService } from "./OtpService.ts";
import { provisionOrganization } from "./OrganizationProvisioningService.ts";
import { onboardingInput, onboardingProof } from "../schemas/pharmacyOnboarding.ts";
import { calculateCommercialQuote, commercialFingerprint, validateCommercialPlan } from "../utilities/commercialQuote.ts";
import { validateProductFootprint } from "./billing/ProductActivationService.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const proofError = () => new CommandError(401, "Setup proof is unavailable or expired. Sign in to a completed workspace, or begin a fresh verified request");
const context = (request: any) => `pharmacy-onboarding:${request.id}:${request.setupTokenHash}`;
function requireTransaction(session: mongoose.ClientSession | null): asserts session is mongoose.ClientSession { if (!session?.inTransaction()) throw new CommandError(503, "Verified business setup requires a transaction-capable database"); }
function planFingerprint(plan: any) { const row = plan.toObject(); return commercialFingerprint({ id: plan.id, pricing: row.commercialPricing, limits: row.limits, legacyTier: row.legacyTier, trialDays: row.trialDays, currency: row.currency }); }
function publicOption(plan: any) {
  validateCommercialPlan(plan);
  if (!plan.selfServicePharmacy || !Number.isSafeInteger(plan.trialDays) || plan.trialDays < 1 || plan.trialDays > 365 || plan.limits.maxLocations < 1 || plan.limits.maxStaff < 1) throw new CommandError(409, "This pharmacy trial is not published for independent setup");
  const preview = calculateCommercialQuote("000000000000000000000001", { ...plan.toObject(), id: plan.id }, { billingCycle: "monthly", priceRevision: plan.commercialPricing.revision, doctorSeats: 0,
    locations: [{ locationId: "000000000000000000000002", clinic: false, pharmacy: true, capabilityRevision: 0 }] });
  return { id: plan.id, name: plan.name, trialDays: plan.trialDays, monthlyTotalPaise: preview.totalPaise, currency: "INR", maxStaff: preview.entitlements.maxStaff, fingerprint: planFingerprint(plan) };
}
async function publishedPlan(planId: string, fingerprint?: string) {
  const plan = await SaaSPlan.findOne({ _id: planId, status: "active", commercialFamily: "location_products", selfServicePharmacy: true });
  if (!plan) throw new CommandError(409, "The selected pharmacy trial is no longer published");
  const option = publicOption(plan);
  if (fingerprint && option.fingerprint !== fingerprint) throw new CommandError(409, "Published trial terms changed. Review the current selection and begin a fresh request"); return plan;
}
export async function pharmacyOnboardingOptions() {
  const plans = await SaaSPlan.find({ status: "active", commercialFamily: "location_products", selfServicePharmacy: true }).sort({ displayOrder: 1, _id: 1 }).limit(20);
  const items = []; for (const plan of plans) { try { items.push(publicOption(plan)); } catch { /* An invalid catalogue is unavailable, never a fabricated offer. */ } }
  return { items };
}
async function readiness() {
  try {
    const indexes = await PharmacyOnboardingRequest.collection.listIndexes().toArray();
    if (!indexes.some(row => row.unique && row.key.email === 1 && Object.keys(row.key).length === 1) || !indexes.some(row => row.unique && row.sparse && row.key.ownerUserId === 1 && Object.keys(row.key).length === 1)) throw Error();
  } catch { throw new CommandError(503, "Prepare current verified-onboarding identity indexes before accepting signup"); }
}
async function requestFor(raw: unknown, otp = false) {
  const proof = onboardingProof(raw, otp ? "otp" : "none");
  const request = await PharmacyOnboardingRequest.findOne({ _id: proof.requestId, setupTokenHash: hash(proof.setupToken), expiresAt: { $gt: new Date() } }).select("+setupTokenHash +intentCiphertext +resultCiphertext");
  if (!request) throw proofError(); return { proof, request };
}
export async function startPharmacyOnboarding(raw: unknown) {
  const input = onboardingInput(raw); await publishedPlan(input.planId, input.planFingerprint); await readiness();
  const existing = await User.findOne({ email: input.email }).select("role");
  if (!existing && !input.password) throw new CommandError(400, "Choose a strong password for a new account");
  const passwordHash = input.password && (!existing || existing.role === "pharmacy_applicant") ? await bcrypt.hash(input.password, 10) : undefined;
  const { password: _password, ...business } = input; void _password;
  const setupToken = crypto.randomBytes(32).toString("hex"), now = new Date(), expiresAt = new Date(now.getTime() + 30 * 60_000);
  const request = await withTransaction(async session => {
    requireTransaction(session);
    const previous = await PharmacyOnboardingRequest.findOne({ email: input.email }).session(session);
    if (previous?.state === "provisioned") throw new CommandError(409, "Business setup is already complete for this account. Sign in to its existing workspace");
    if (previous && now.getTime() - previous.lastSentAt.getTime() < 60_000) throw new CommandError(429, "Wait a minute before requesting another setup code");
    const values = { setupTokenHash: hash(setupToken), intentCiphertext: JSON.stringify({ ...business, passwordHash }), state: "pending", expiresAt, lastSentAt: now };
    return previous ? PharmacyOnboardingRequest.findOneAndUpdate({ _id: previous._id, state: { $ne: "provisioned" } }, { $set: values, $unset: { verifiedAt: 1 } }, { session, returnDocument: "after", runValidators: true }).select("+setupTokenHash")
      : createWithSession(PharmacyOnboardingRequest, { email: input.email, ...values }, session);
  });
  if (!request) throw proofError();
  const delivery = await otpService.requestOtp({ email: input.email }, "business_onboarding", context(request)).catch(() => ({ success: false }));
  return { requestId: request.id, setupToken, state: "pending", expiresAt, deliveryAvailable: delivery.success, message: delivery.success ? "Check your email for the business setup code" : "Email delivery is unavailable. Keep this setup reference and resend later" };
}
export async function resendPharmacyOnboarding(raw: unknown) {
  const { request } = await requestFor(raw);
  if (request.state !== "pending") throw new CommandError(409, "Email is already verified for this setup request");
  const now = new Date();
  const saved = await PharmacyOnboardingRequest.findOneAndUpdate({ _id: request._id, setupTokenHash: request.setupTokenHash, state: "pending", lastSentAt: { $lte: new Date(now.getTime() - 60_000) } }, { $set: { lastSentAt: now } }, { returnDocument: "after" }).select("+setupTokenHash");
  if (!saved) throw new CommandError(429, "Wait a minute before resending the setup code");
  const delivery = await otpService.requestOtp({ email: request.email }, "business_onboarding", context(saved)).catch(() => ({ success: false }));
  return { state: "pending", deliveryAvailable: delivery.success, message: delivery.success ? "A new setup code was sent" : "Email delivery is unavailable. Retry later" };
}
export async function verifyPharmacyOnboarding(raw: unknown) {
  const proof = onboardingProof(raw, "otp");
  const result = await withTransaction(async session => {
    requireTransaction(session);
    const request = await PharmacyOnboardingRequest.findOneAndUpdate({ _id: proof.requestId, setupTokenHash: hash(proof.setupToken), expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session, returnDocument: "after" }).select("+setupTokenHash +intentCiphertext");
    if (!request) throw proofError();
    if (request.state !== "pending") return { state: request.state };
    const verified = await otpService.verifyOtp({ email: request.email }, proof.otp!, "business_onboarding", context(request));
    // Return failure so the transaction commits the OTP attempt count before the HTTP error.
    if (!verified.success) return { failure: verified.message };
    const intent = JSON.parse(decryptField(request.intentCiphertext));
    let user = await User.findOne({ email: request.email }).session(session);
    if (user && (!user.isActive || ["root", "guest"].includes(user.role))) throw new CommandError(403, "Use this account's existing sign-in and authorized provisioning flow");
    if (!user) {
      if (!intent.passwordHash) throw new CommandError(400, "Begin a new setup request with a strong new-account password");
      user = await createWithSession(User, { email: request.email, name: intent.ownerName, password: intent.passwordHash, role: "pharmacy_applicant", isEmailVerified: true }, session);
    } else {
      const update = { isEmailVerified: true, ...(user.role === "pharmacy_applicant" && intent.passwordHash ? { password: intent.passwordHash } : {}) };
      await User.updateOne({ _id: user._id, isActive: true, email: request.email }, { $set: update }).session(session);
    }
    const prior = await PharmacyOnboardingRequest.exists({ ownerUserId: user!._id, _id: { $ne: request._id } }).session(session);
    if (prior) throw new CommandError(409, "This account already has a business setup claim. Sign in to its existing workspace");
    const { passwordHash: _passwordHash, ...verifiedIntent } = intent; void _passwordHash;
    request.intentCiphertext = JSON.stringify(verifiedIntent);
    request.ownerUserId = user!._id; request.state = "verified"; request.verifiedAt = new Date(); await request.save({ session });
    return { state: "verified" };
  });
  if (result.failure) throw new CommandError(400, result.failure); return result;
}
export async function pharmacyOnboardingStatus(raw: unknown) {
  const { request } = await requestFor(raw);
  return { state: request.state, expiresAt: request.expiresAt, ...(request.state === "provisioned" ? { organizationId: String(request.organizationId) } : {}) };
}
export async function completePharmacyOnboarding(raw: unknown, requestKey: unknown) {
  const { proof, request: initial } = await requestFor(raw);
  if (typeof requestKey !== "string" || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw new CommandError(428, "Keep one stable setup completion reference");
  if (initial.state === "pending" || !initial.ownerUserId) throw new CommandError(403, "Verify account email before creating an organization or membership");
  const commandScope = `pharmacy-onboarding:${initial.id}`, ownerUserId = String(initial.ownerUserId);
  const command = await executeRecordedCommand(commandScope, requestKey, { requestId: initial.id, ownerUserId }, () => withTransaction(async session => {
    requireTransaction(session);
    const request = await PharmacyOnboardingRequest.findOneAndUpdate({ _id: initial._id, setupTokenHash: hash(proof.setupToken), ownerUserId, state: { $in: ["verified", "provisioned"] }, expiresAt: { $gt: new Date() } }, { $inc: { __v: 1 } }, { session, returnDocument: "after" }).select("+intentCiphertext +resultCiphertext");
    if (!request) throw proofError();
    const owner = await User.findOneAndUpdate({ _id: ownerUserId, email: request.email, isActive: true, isEmailVerified: true }, { $inc: { __v: 1 } }, { session, returnDocument: "after" });
    if (!owner) throw proofError();
    let data: any;
    if (request.state === "provisioned") data = JSON.parse(decryptField(request.resultCiphertext!));
    else {
      const intent = JSON.parse(decryptField(request.intentCiphertext)), plan = await publishedPlan(intent.planId, intent.planFingerprint);
      const pinnedPlan = await SaaSPlan.findOneAndUpdate({ _id: plan._id, status: "active", selfServicePharmacy: true, "commercialPricing.revision": plan.commercialPricing!.revision, trialDays: plan.trialDays }, { $inc: { __v: 1 } }, { session, returnDocument: "after" });
      if (!pinnedPlan || planFingerprint(pinnedPlan) !== intent.planFingerprint) throw new CommandError(409, "Published trial terms changed before setup committed; review a fresh selection");
      const created = await provisionOrganization({ org_name: intent.businessName, city: intent.city, address: intent.address, org_phone: intent.businessPhone,
        org_email: request.email, admin_name: owner.name, admin_email: request.email, admin_password: "", facilityType: "pharmacy", plan: plan.legacyTier!,
        countryCode: "IN", currency: "INR", timezone: "Asia/Kolkata", sendWelcomeEmail: false }, { verifiedOwnerUserId: ownerUserId, workspaceProfile: "pharmacy", staffMfaRequired: true,
        initializeSubscription: async ({ organizationId, locationId }, currentSession) => {
          requireTransaction(currentSession); const now = new Date();
          const location = await Location.findById(locationId).select("pharmacyCapability");
          const quote = calculateCommercialQuote(organizationId, { ...plan.toObject(), id: plan.id }, { billingCycle: "monthly", priceRevision: plan.commercialPricing!.revision, doctorSeats: 0,
            locations: [{ locationId, clinic: false, pharmacy: true, capabilityRevision: location!.pharmacyCapability!.revision }] }, now);
          await validateProductFootprint(quote, currentSession, true);
          const trialEndsAt = new Date(now.getTime() + plan.trialDays * 86400000);
          await createWithSession(Subscription, { organizationId, planId: plan._id, commercialQuote: quote, status: "trialing", entitlementSource: "trial", billingCycle: "monthly",
            trialStartedAt: now, trialEndsAt, currentPeriodStart: now, currentPeriodEnd: trialEndsAt,
            manualGrantReason: `Verified independent pharmacy setup ${request.id}`, manualGrantedBy: ownerUserId, manualGrantedAt: now }, currentSession);
          await Organization.updateOne({ _id: organizationId }, { $set: { maxLocations: quote.entitlements.maxLocations, maxDoctors: quote.entitlements.maxDoctors, maxStaff: quote.entitlements.maxStaff } }).session(currentSession);
        } });
      const location = await Location.findOne({ organizationId: created.organization.id }).select("_id"), subscription = await Subscription.findOne({ organizationId: created.organization.id }).select("trialEndsAt");
      data = { organization: created.organization, ownerUserId, locationId: String(location!._id), trialEndsAt: subscription!.trialEndsAt, workspaceProfile: "pharmacy" };
      request.state = "provisioned"; request.organizationId = new mongoose.Types.ObjectId(created.organization.id); request.provisionedAt = new Date(); request.resultCiphertext = JSON.stringify(data); await request.save({ session });
      await createWithSession(AuditLog, { organizationId: created.organization.id, userId: ownerUserId, action: "PHARMACY_SELF_SERVICE_PROVISIONED", category: "ADMIN", targetModel: "PharmacyOnboardingRequest", targetId: request._id,
        details: { planId: plan.id, locationId: data.locationId, trialEndsAt: data.trialEndsAt, profile: "pharmacy" } }, session);
    }
    const receipt = await OperationReceipt.updateOne({ scope: commandScope, key: requestKey }, { $set: { responseCiphertext: JSON.stringify({ version: 1, ownerUserId, data }) } }).session(session);
    if (receipt.matchedCount !== 1) throw new CommandError(409, "Setup completion reference changed; check the same reference"); return String(data.organization.id);
  }), { writeConcern: { w: "majority" } });
  const receipt = await OperationReceipt.findOne({ scope: commandScope, key: requestKey }).select("+responseCiphertext");
  const recorded = receipt?.responseCiphertext ? JSON.parse(decryptField(receipt.responseCiphertext)) : null;
  if (!recorded || recorded.version !== 1 || recorded.ownerUserId !== ownerUserId || String(recorded.data?.organization?.id) !== String(command.resultId)) throw new CommandError(409, "Setup is recorded but its result requires review; retain the reference");
  return { ...recorded.data, replayed: command.replayed };
}

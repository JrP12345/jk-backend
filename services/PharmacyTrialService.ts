import mongoose from "mongoose";
import { SaaSPlan } from "../models/SaaSPlan.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { Subscription } from "../models/Subscription.ts";
import { calculateCommercialQuote, commercialFingerprint, validateCommercialPlan } from "../utilities/commercialQuote.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { validateProductFootprint } from "./billing/ProductActivationService.ts";
import { provisionOrganization, type OrganizationProvisionInput, type OrganizationProvisionOptions } from "./OrganizationProvisioningService.ts";

export function pharmacyPlanFingerprint(plan: any) {
  const row = plan.toObject();
  return commercialFingerprint({ id: plan.id, pricing: row.commercialPricing, limits: row.limits, legacyTier: row.legacyTier, trialDays: row.trialDays, currency: row.currency });
}
export function pharmacyTrialOption(plan: any) {
  validateCommercialPlan(plan);
  if (!plan.selfServicePharmacy || !Number.isSafeInteger(plan.trialDays) || plan.trialDays < 1 || plan.trialDays > 365 || plan.limits.maxLocations < 1 || plan.limits.maxStaff < 1) throw new CommandError(409, "This pharmacy trial is not published for independent setup");
  const preview = calculateCommercialQuote("000000000000000000000001", { ...plan.toObject(), id: plan.id }, { billingCycle: "monthly", priceRevision: plan.commercialPricing.revision, doctorSeats: 0,
    locations: [{ locationId: "000000000000000000000002", clinic: false, pharmacy: true, capabilityRevision: 0 }] });
  return { id: plan.id, name: plan.name, trialDays: plan.trialDays, monthlyTotalPaise: preview.totalPaise, currency: "INR", maxStaff: preview.entitlements.maxStaff, fingerprint: pharmacyPlanFingerprint(plan) };
}
export async function loadPublishedPharmacyTrial(planId: string, fingerprint?: string) {
  if (!mongoose.isValidObjectId(planId)) throw new CommandError(400, "Select a published pharmacy trial");
  const plan = await SaaSPlan.findOne({ _id: planId, status: "active", commercialFamily: "location_products", selfServicePharmacy: true });
  if (!plan) throw new CommandError(409, "The selected pharmacy trial is no longer published");
  const option = pharmacyTrialOption(plan);
  if (fingerprint && option.fingerprint !== fingerprint) throw new CommandError(409, "Published trial terms changed. Review the current selection and begin a fresh request");
  return plan;
}
export async function pinPublishedPharmacyTrial(planId: string, fingerprint: string, session: mongoose.ClientSession | null) {
  if (!session?.inTransaction()) throw new CommandError(503, "Pharmacy setup requires a transaction-capable database");
  const plan = await loadPublishedPharmacyTrial(planId, fingerprint);
  const pinned = await SaaSPlan.findOneAndUpdate({ _id: plan._id, status: "active", commercialFamily: "location_products", selfServicePharmacy: true, "commercialPricing.revision": plan.commercialPricing!.revision, trialDays: plan.trialDays }, { $inc: { __v: 1 } }, { session, returnDocument: "after" });
  if (!pinned || pharmacyPlanFingerprint(pinned) !== fingerprint) throw new CommandError(409, "Published trial terms changed before setup committed; review a fresh selection");
  return pinned;
}
export function pharmacyTrialInitializer(plan: any, actorId: string, reason: string): NonNullable<OrganizationProvisionOptions["initializeSubscription"]> {
  return async ({ organizationId, locationId }, session) => {
    if (!session?.inTransaction()) throw new CommandError(503, "Pharmacy setup requires a transaction-capable database");
    const now = new Date();
    const location = await Location.findById(locationId).select("pharmacyCapability").session(session);
    if (!location?.pharmacyCapability) throw new CommandError(409, "The pharmacy branch could not be confirmed");
    const quote = calculateCommercialQuote(organizationId, { ...plan.toObject(), id: plan.id }, { billingCycle: "monthly", priceRevision: plan.commercialPricing.revision, doctorSeats: 0,
      locations: [{ locationId, clinic: false, pharmacy: true, capabilityRevision: location.pharmacyCapability.revision }] }, now);
    await validateProductFootprint(quote, session, true);
    const trialEndsAt = new Date(now.getTime() + plan.trialDays * 86400000);
    await createWithSession(Subscription, { organizationId, planId: plan._id, commercialQuote: quote, status: "trialing", entitlementSource: "trial", billingCycle: "monthly",
      trialStartedAt: now, trialEndsAt, currentPeriodStart: now, currentPeriodEnd: trialEndsAt,
      manualGrantReason: reason, manualGrantedBy: actorId, manualGrantedAt: now }, session);
    await Organization.updateOne({ _id: organizationId }, { $set: { maxLocations: quote.entitlements.maxLocations, maxDoctors: quote.entitlements.maxDoctors, maxStaff: quote.entitlements.maxStaff } }).session(session);
  };
}
export async function provisionAssistedPharmacy(input: OrganizationProvisionInput, planId: string, fingerprint: string, actorId: string) {
  if (!/^[a-f\d]{64}$/i.test(fingerprint || "")) throw new CommandError(400, "Review current published pharmacy trial terms before creating the organization");
  if (input.countryCode !== "IN" || input.currency && input.currency !== "INR") throw new CommandError(400, "Pharmacy setup currently supports India and INR");
  if ((input.location_address || input.address || "").trim().length < 5 || (input.location_phone || input.org_phone || "").trim().length < 7) throw new CommandError(400, "Provide the pharmacy branch address and contact number");
  if (input.trialDays !== undefined) throw new CommandError(400, "Pharmacy trial duration comes from the reviewed product plan");
  return withTransaction(async session => {
    const plan = await pinPublishedPharmacyTrial(planId, fingerprint, session);
    return provisionOrganization({ ...input, plan: plan.legacyTier!, facilityType: "pharmacy" }, { workspaceProfile: "pharmacy",
      initializeSubscription: pharmacyTrialInitializer(plan, actorId, "Root-assisted pharmacy setup using reviewed published trial terms") });
  });
}

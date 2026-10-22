import type { ClientSession, HydratedDocument } from "mongoose";
import { Location } from "../../models/Location.ts";
import { Organization } from "../../models/Organization.ts";
import { Doctor } from "../../models/Doctor.ts";
import { Receptionist } from "../../models/Receptionist.ts";
import { Subscription } from "../../models/Subscription.ts";
import { encryptField, decryptField, isEncrypted } from "../../utilities/cryptoEnvelope.ts";
import { calculateCommercialQuote, commercialFingerprint, type CommercialQuote } from "../../utilities/commercialQuote.ts";
import { CommandError } from "../CommandReceiptService.ts";

/** Authenticated server-issued pricing intent, never proof of payment or permission. */
export function sealProductQuote(quote: CommercialQuote) {
  return encryptField(JSON.stringify({ purpose: "subscription-product-quote-v1", quote }));
}
export function openProductQuote(token: unknown, organizationId: string, planId: string, cycle: string): CommercialQuote {
  try {
    if (typeof token !== "string" || token.length > 150_000 || !isEncrypted(token)) throw new Error();
    const sealed = JSON.parse(decryptField(token)), quote = sealed.quote as CommercialQuote;
    if (sealed.purpose !== "subscription-product-quote-v1" || quote.version !== 1 || quote.organizationId !== organizationId || quote.planId !== planId || quote.billingCycle !== cycle) throw new Error();
    return quote;
  } catch { throw new CommandError(409, "A server-issued location-product quote for this organization, plan and cycle is required"); }
}

export function productSelectionIdentity(quote: CommercialQuote) {
  return commercialFingerprint({ planId: quote.planId, billingCycle: quote.billingCycle, limits: {
    maxLocations: quote.entitlements.maxLocations, maxDoctors: quote.entitlements.maxDoctors, maxStaff: quote.entitlements.maxStaff,
  }, locations: quote.entitlements.locations.map(({ locationId, clinic, pharmacy }) => ({ locationId, clinic, pharmacy })) });
}

export function subscriptionBillingIdentity(subscription: HydratedDocument<any>) {
  return commercialFingerprint({ planId: String(subscription.planId?._id ?? subscription.planId),
    periodStart: new Date(subscription.currentPeriodStart).toISOString(), periodEnd: new Date(subscription.currentPeriodEnd).toISOString(),
    source: subscription.entitlementSource ?? null, quote: subscription.commercialQuote?.fingerprint ?? null });
}

export function assertProductChangeAllowed(subscription: HydratedDocument<any>, quote: CommercialQuote, now = new Date()) {
  if (subscription.commercialQuote && ["active", "cancelled", "trialing"].includes(subscription.status) &&
      new Date(subscription.status === "trialing" ? subscription.trialEndsAt : subscription.currentPeriodEnd) > now &&
      productSelectionIdentity(subscription.commercialQuote.toObject?.() ?? subscription.commercialQuote) !== productSelectionIdentity(quote)) {
    throw new CommandError(409, "The current product period is still valid. Renew the same selection or change products after it ends; proration is not configured");
  }
}

/** Recheck the captured footprint; money is never repriced on capture. */
export async function validateProductFootprint(quote: CommercialQuote, session: ClientSession | null, pin = false) {
  if ((await Subscription.find({ organizationId: quote.organizationId }).select("_id").limit(2).session(session).lean()).length > 1) throw new CommandError(409, "Product subscription needs review before checkout or activation");
  const organization = await Organization.findById(quote.organizationId).select("isActive status currency countryCode").session(session).lean();
  if (!organization || organization.isActive === false || organization.status === "inactive" || organization.currency !== "INR" || organization.countryCode !== "IN") throw new CommandError(409, "Product organization needs review");
  const locations = await Location.find({ organizationId: quote.organizationId, isActive: { $ne: false } }).select("pharmacyCapability").limit(101).session(session).lean();
  if (locations.length !== quote.entitlements.locations.length || locations.some(location => !quote.entitlements.locations.some(selected =>
    selected.locationId === String(location._id) && selected.capabilityRevision === (location.pharmacyCapability?.revision ?? 0)))) throw new CommandError(409, "Location selection or capability changed; review a new quote");
  const doctors = await Doctor.countDocuments({ organizationId: quote.organizationId, isActive: { $ne: false } }).session(session);
  const staff = await Receptionist.countDocuments({ organizationId: quote.organizationId, status: { $ne: "inactive" } }).session(session);
  if (doctors > quote.entitlements.maxDoctors || staff > quote.entitlements.maxStaff) throw new CommandError(409, "Active doctor or staff profiles exceed the quoted capacity");
  if (pin) {
    for (const selected of quote.entitlements.locations) {
      const result = await Location.findOneAndUpdate({ _id: selected.locationId, organizationId: quote.organizationId, isActive: { $ne: false } }, { $inc: { __v: 1 } }, { session });
      if (!result) throw new CommandError(409, "Product location changed");
    }
  }
}

export async function validateFreshProductQuote(quote: CommercialQuote, plan: HydratedDocument<any>, session: ClientSession | null = null) {
  if (!(Date.parse(quote.expiresAt) > Date.now())) throw new CommandError(409, "Product quote expired; preview it again before checkout");
  const refreshed = calculateCommercialQuote(quote.organizationId, { ...plan.toObject(), id: String(plan._id) }, {
    billingCycle: quote.billingCycle, priceRevision: quote.priceRevision, doctorSeats: quote.entitlements.maxDoctors, locations: quote.entitlements.locations,
  }, new Date(quote.periodStart));
  if (refreshed.fingerprint !== quote.fingerprint) throw new CommandError(409, "Product pricing or capacity changed; review a new quote");
  await validateProductFootprint(quote, session);
}


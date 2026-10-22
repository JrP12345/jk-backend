import { Organization } from "../../models/Organization.ts";
import { Subscription } from "../../models/Subscription.ts";
import { SubscriptionPayment } from "../../models/SubscriptionPayment.ts";
import { Location } from "../../models/Location.ts";
import { SaaSPlan } from "../../models/SaaSPlan.ts";
import type { ClientSession } from "mongoose";
import { LEGACY_TIERS, quoteFingerprint, type CommercialQuote } from "../../utilities/commercialQuote.ts";
import { CommandError } from "../CommandReceiptService.ts";

/** Current standard clinic plans include module-enabled pharmacy; selected products are branch-bound. */
export async function getOrganizationProductEntitlements(organizationId: string, now = new Date(), session: ClientSession | null = null) {
  const organization = await Organization.findById(organizationId).select("isActive status maxLocations maxDoctors maxStaff").session(session).lean();
  if (!organization) throw new CommandError(404, "Organization not found");
  const subscriptions = await Subscription.find({ organizationId }).sort({ createdAt: 1, _id: 1 }).limit(2).session(session).lean();
  const base = { enforcement: false, mode: "legacy_included", active: false, source: subscriptions[0]?.entitlementSource || "legacy",
    limits: { maxLocations: organization.maxLocations ?? 1, maxDoctors: organization.maxDoctors ?? 2, maxStaff: organization.maxStaff ?? 2 },
    clinicLocationIds: [] as string[], pharmacyLocationIds: [] as string[], fingerprint: null as string | null };
  if (subscriptions.length > 1) return { ...base, enforcement: true, mode: "review_required" };
  const subscription = subscriptions[0];
  const enabled = organization.isActive !== false && organization.status !== "inactive";
  const periodActive = Boolean(subscription && (subscription.status === "trialing" ? new Date(subscription.trialEndsAt) > now && new Date(subscription.trialStartedAt) <= now
    : ["active", "cancelled"].includes(subscription.status) && new Date(subscription.currentPeriodStart) <= now && new Date(subscription.currentPeriodEnd) > now));
  if (!subscription?.commercialQuote) {
    const productPlan = subscription && await SaaSPlan.exists({ _id: subscription.planId, commercialFamily: "location_products" }).session(session);
    return { ...base, enforcement: Boolean(productPlan), mode: productPlan ? "review_required" : base.mode, active: enabled && periodActive && !productPlan };
  }
  base.enforcement = true;
  const quote = subscription.commercialQuote as unknown as CommercialQuote;
  try {
    const { fingerprint, ...body } = quote;
    const ids = quote.entitlements.locations.map(location => location.locationId);
    const lineAmount = quote.lines.reduce((sum, line) => sum + line.amountPaise, 0);
    const expectedTax = quote.taxMode === "inclusive" ? lineAmount - Math.round(lineAmount * 10000 / (10000 + quote.taxRateBps)) : Math.round(lineAmount * quote.taxRateBps / 10000);
    const valid = quote.version === 1 && quote.organizationId === organizationId && quote.planId === String(subscription.planId) && quote.currency === "INR" &&
      fingerprint === quoteFingerprint(body) && /^[a-f\d]{64}$/.test(fingerprint) && LEGACY_TIERS.includes(quote.legacyTier) && ["pharmacy", "clinic", "mixed"].includes(quote.commercialFamily) &&
      ["inclusive", "exclusive"].includes(quote.taxMode) && Number.isSafeInteger(quote.taxRateBps) && quote.taxRateBps >= 0 && quote.taxRateBps <= 10000 &&
      quote.lines.length > 0 && new Set(quote.lines.map(line => line.id)).size === quote.lines.length && quote.lines.every(line =>
        Number.isSafeInteger(line.quantity) && line.quantity > 0 && Number.isSafeInteger(line.unitPricePaise) && line.unitPricePaise >= 0 && Number.isSafeInteger(line.amountPaise) && line.amountPaise >= 0 && line.quantity * line.unitPricePaise === line.amountPaise &&
        (line.kind === "extra_doctor" ? line.id === "extra_doctor" && !line.locationId && line.quantity <= quote.entitlements.maxDoctors :
          line.quantity === 1 && line.id === `${line.kind}:${line.locationId}` && quote.entitlements.locations.some(location => location.locationId === line.locationId &&
            (line.kind === "clinic" ? location.clinic : line.kind === "pharmacy_addon" ? location.clinic && location.pharmacy : line.kind === "pharmacy" && !location.clinic && location.pharmacy)))) &&
      Number.isSafeInteger(quote.totalPaise) && quote.totalPaise >= 0 && Number.isSafeInteger(quote.taxPaise) && quote.taxPaise >= 0 && quote.subtotalPaise + quote.taxPaise === quote.totalPaise &&
      quote.taxPaise === expectedTax && lineAmount === (quote.taxMode === "inclusive" ? quote.totalPaise : quote.subtotalPaise) &&
      quote.entitlements.maxLocations === ids.length && ids.length > 0 && new Set(ids).size === ids.length &&
      [quote.entitlements.maxDoctors, quote.entitlements.maxStaff].every(value => Number.isSafeInteger(value) && value >= 0) &&
      quote.entitlements.locations.every(location => /^[a-f\d]{24}$/.test(location.locationId) && typeof location.clinic === "boolean" && typeof location.pharmacy === "boolean" &&
        (location.clinic || location.pharmacy) && Number.isSafeInteger(location.capabilityRevision) && location.capabilityRevision >= 0 &&
        (!location.clinic || quote.lines.some(line => line.kind === "clinic" && line.locationId === location.locationId)) &&
        (!location.pharmacy || quote.lines.some(line => line.kind === (location.clinic ? "pharmacy_addon" : "pharmacy") && line.locationId === location.locationId))) &&
      Date.parse(quote.periodEnd) > Date.parse(quote.periodStart);
    if (!valid) return { ...base, mode: "review_required" };
    const locations = await Location.countDocuments({ organizationId, _id: { $in: ids }, isActive: { $ne: false } }).session(session);
    if (locations !== ids.length) return { ...base, mode: "review_required" };
    let evidence = false;
    if (subscription.entitlementSource === "paid") evidence = Boolean(await SubscriptionPayment.exists({ organizationId, subscriptionId: subscription._id, planId: subscription.planId,
      status: "captured", "commercialQuote.fingerprint": fingerprint, currency: "INR", amount: quote.totalPaise / 100, paidAt: { $lte: now } }).session(session));
    else if (subscription.entitlementSource === "manual") evidence = Boolean(subscription.manualGrantedBy && subscription.manualGrantedAt && new Date(subscription.manualGrantedAt) <= now && (subscription.manualGrantReason?.trim().length || 0) >= 10);
    else if (subscription.entitlementSource === "trial") evidence = subscription.status === "trialing";
    else if (subscription.entitlementSource === "free") evidence = quote.totalPaise === 0;
    if (!evidence) return { ...base, mode: "review_required" };
    // Quote dates describe pricing intent. Verified activation/renewal owns the effective period.
    const active = enabled && periodActive;
    return { ...base, mode: "configured", active, limits: { maxLocations: quote.entitlements.maxLocations, maxDoctors: quote.entitlements.maxDoctors, maxStaff: quote.entitlements.maxStaff }, fingerprint,
      clinicLocationIds: active ? quote.entitlements.locations.filter(location => location.clinic).map(location => location.locationId) : [],
      pharmacyLocationIds: active ? quote.entitlements.locations.filter(location => location.pharmacy).map(location => location.locationId) : [] };
  } catch { return { ...base, mode: "review_required" }; }
}

import { Location } from "../../models/Location.ts";
import { Organization } from "../../models/Organization.ts";
import { Subscription } from "../../models/Subscription.ts";
import { subscriptionService } from "./SubscriptionService.ts";
import mongoose from "mongoose";
import { getOrganizationProductEntitlements } from "./ProductEntitlementService.ts";
import { isProductPlan } from "../../utilities/commercialQuote.ts";
export { getOrganizationProductEntitlements } from "./ProductEntitlementService.ts";

/** Existing care remains available; only creation of new location business is gated. */
export async function canCreateLocationBooking(locationId: string, requirePublished = false): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(locationId)) return false;
  const location = await Location.findById(locationId).select("organizationId isActive isPublished").lean();
  if (requirePublished && location?.isPublished === false) return false;
  if (!location || location.isActive === false || !location.organizationId) return false;
  return canCreateOrganizationBooking(location.organizationId.toString(), locationId);
}

export async function canCreateOrganizationBooking(organizationId: string, locationId?: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return false;
  const organization = await Organization.findById(organizationId).select("isActive status").lean();
  if (!organization || organization.isActive === false || organization.status === "inactive") return false;
  const subscription = await subscriptionService.getOrInitializeSubscription(organizationId);
  if (!subscriptionAllowsBooking(subscription)) return false;
  if (!subscription.commercialQuote && !isProductPlan(subscription.planId)) return true;
  const entitlement = await getOrganizationProductEntitlements(organizationId);
  return entitlement.active && (locationId ? entitlement.clinicLocationIds.includes(locationId) : entitlement.clinicLocationIds.length > 0);
}

function subscriptionAllowsBooking(subscription: { status: string; trialEndsAt: Date; currentPeriodEnd: Date }): boolean {
  const now = Date.now();
  if (subscription.status === "trialing") return new Date(subscription.trialEndsAt).getTime() > now;
  if (["active", "cancelled"].includes(subscription.status)) return new Date(subscription.currentPeriodEnd).getTime() > now;
  return false;
}

/** Read existing entitlements in one query for a public result page. Initialize only new organizations. */
export async function getOrganizationBookingAccess(organizationIds: string[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(organizationIds.filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const [organizations, subscriptions] = await Promise.all([
    Organization.find({ _id: { $in: ids }, isActive: { $ne: false }, status: { $ne: "inactive" } }).select("_id").lean(),
    Subscription.find({ organizationId: { $in: ids } }).sort({ createdAt: 1, _id: 1 }).select("organizationId status trialEndsAt currentPeriodEnd commercialQuote").lean(),
  ]);
  const activeIds = new Set(organizations.map((organization) => organization._id.toString()));
  const subscriptionsByOrganization = new Map<string, typeof subscriptions[number]>();
  for (const subscription of subscriptions) {
    const id = subscription.organizationId.toString();
    if (!subscriptionsByOrganization.has(id)) subscriptionsByOrganization.set(id, subscription);
  }
  const access = new Map<string, boolean>();
  for (const id of ids) {
    if (!activeIds.has(id)) access.set(id, false);
    else if (subscriptionsByOrganization.has(id)) {
      const subscription = subscriptionsByOrganization.get(id)!;
      if (!subscriptionAllowsBooking(subscription)) access.set(id, false);
      else if (subscription.commercialQuote) {
        const entitlement = await getOrganizationProductEntitlements(id);
        access.set(id, entitlement.active && entitlement.clinicLocationIds.length > 0);
      } else access.set(id, true);
    }
  }
  await Promise.all(ids.filter((id) => !access.has(id)).map(async (id) => {
    access.set(id, await canCreateOrganizationBooking(id));
  }));
  return access;
}

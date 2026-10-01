import { Clinic } from "../../models/Clinic.ts";
import { Organization } from "../../models/Organization.ts";
import { Subscription } from "../../models/Subscription.ts";
import { subscriptionService } from "./SubscriptionService.ts";
import mongoose from "mongoose";

/** Existing care remains available; only creation of new clinic business is gated. */
export async function canCreateClinicBooking(clinicId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(clinicId)) return false;
  const clinic = await Clinic.findById(clinicId).select("organizationId isActive").lean();
  if (!clinic || clinic.isActive === false || !clinic.organizationId) return false;
  return canCreateOrganizationBooking(clinic.organizationId.toString());
}

export async function canCreateOrganizationBooking(organizationId: string): Promise<boolean> {
  if (!mongoose.Types.ObjectId.isValid(organizationId)) return false;
  const organization = await Organization.findById(organizationId).select("isActive status").lean();
  if (!organization || organization.isActive === false || organization.status === "inactive") return false;
  const subscription = await subscriptionService.getOrInitializeSubscription(organizationId);
  return subscriptionAllowsBooking(subscription);
}

function subscriptionAllowsBooking(subscription: { status: string; trialEndsAt: Date; currentPeriodEnd: Date }): boolean {
  const now = Date.now();
  if (subscription.status === "trialing") return new Date(subscription.trialEndsAt).getTime() > now;
  if (subscription.status === "active") return new Date(subscription.currentPeriodEnd).getTime() > now;
  return false;
}

/** Read existing entitlements in one query for a public result page. Initialize only new organizations. */
export async function getOrganizationBookingAccess(organizationIds: string[]): Promise<Map<string, boolean>> {
  const ids = [...new Set(organizationIds.filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  const [organizations, subscriptions] = await Promise.all([
    Organization.find({ _id: { $in: ids }, isActive: { $ne: false }, status: { $ne: "inactive" } }).select("_id").lean(),
    Subscription.find({ organizationId: { $in: ids } }).sort({ createdAt: 1, _id: 1 }).select("organizationId status trialEndsAt currentPeriodEnd").lean(),
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
    else if (subscriptionsByOrganization.has(id)) access.set(id, subscriptionAllowsBooking(subscriptionsByOrganization.get(id)!));
  }
  await Promise.all(ids.filter((id) => !access.has(id)).map(async (id) => {
    access.set(id, await canCreateOrganizationBooking(id));
  }));
  return access;
}

import { Clinic } from "../../models/Clinic.ts";
import { Organization } from "../../models/Organization.ts";
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
  const now = Date.now();
  if (subscription.status === "trialing") return new Date(subscription.trialEndsAt).getTime() > now;
  if (subscription.status === "active") return new Date(subscription.currentPeriodEnd).getTime() > now;
  return false;
}

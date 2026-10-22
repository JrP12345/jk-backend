import { Location } from "../models/Location.ts";
import type { ClientSession } from "mongoose";
import { CommandError } from "../services/CommandReceiptService.ts";
import { getOrganizationProductEntitlements } from "../services/billing/ProductEntitlementService.ts";
import { Subscription } from "../models/Subscription.ts";

/** Write at the end of each new inventory transaction. A concurrent disable changes this
 * document, forcing transaction retry/rollback before any stock or financial writes commit. */
export async function pinActivePharmacyLocation(locationId: string, session: ClientSession | null, requireProduct = true) {
  const location = await Location.findOneAndUpdate({ _id: locationId, isActive: { $ne: false }, "pharmacyCapability.enabled": { $ne: false } }, { $inc: { __v: 1 } }, { session });
  if (!location) throw new CommandError(409, "Pharmacy is disabled at this location; existing records remain available for authorized review");
  if (!requireProduct) return location;
  const entitlement = await getOrganizationProductEntitlements(String(location.organizationId), new Date(), session);
  if (entitlement.enforcement) {
    if (!entitlement.active || !entitlement.pharmacyLocationIds.includes(locationId)) throw new CommandError(402, "An active pharmacy product at this location is required for new business; records, corrections and settlements remain available");
    const pinned = await Subscription.findOneAndUpdate({ organizationId: location.organizationId, "commercialQuote.fingerprint": entitlement.fingerprint,
      status: { $in: ["active", "cancelled", "trialing"] }, $or: [
        { status: "trialing", trialEndsAt: { $gt: new Date() } },
        { status: { $in: ["active", "cancelled"] }, currentPeriodEnd: { $gt: new Date() } },
      ] }, { $inc: { __v: 1 } }, { session });
    if (!pinned) throw new CommandError(402, "Pharmacy product period changed; reload before new business");
  }
  return location;
}

/** Corrections to existing supplies remain available after the pharmacy capability is disabled. */
export async function pinPharmacyContinuityLocation(locationId: string, session: ClientSession | null) {
  const location = await Location.findOneAndUpdate({ _id: locationId, isActive: { $ne: false } }, { $inc: { __v: 1 } }, { session });
  if (!location) throw new CommandError(409, "Source pharmacy location needs review");
  return location;
}

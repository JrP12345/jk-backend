import { Location } from "../models/Location.ts";
import type { ClientSession } from "mongoose";
import { CommandError } from "../services/CommandReceiptService.ts";
import { getOrganizationProductEntitlements } from "../services/billing/ProductEntitlementService.ts";
import { Subscription } from "../models/Subscription.ts";
import { offlineOwnerFilter } from "./pharmacyOfflineOwnership.ts";

/** Write at the end of each new inventory transaction. A concurrent disable changes this
 * document, forcing transaction retry/rollback before any stock or financial writes commit. */
export async function pinActivePharmacyLocation(locationId: string, session: ClientSession | null, requireProduct = true, requireStock = false) {
  const location = await Location.findOneAndUpdate({ _id: locationId, ...offlineOwnerFilter(locationId), isActive: { $ne: false }, "pharmacyCapability.enabled": { $ne: false }, ...(requireStock ? { "pharmacyCapability.inventoryMode": { $ne: "billing_only" } } : {}) }, { $inc: { __v: 1 } }, { session });
  if (!location) throw new CommandError(409, "Pharmacy is disabled, assigned to an offline billing PC, or stock tracking is unavailable; existing records remain available for authorized review");
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
  const location = await Location.findOneAndUpdate({ _id: locationId, ...offlineOwnerFilter(locationId), isActive: { $ne: false } }, { $inc: { __v: 1 } }, { session });
  if (!location) throw new CommandError(409, "Source pharmacy location needs review or is assigned to an offline billing PC");
  return location;
}

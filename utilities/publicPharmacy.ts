/** Inventory publication and pickup are independently opt-in. */
export function publicPharmacyFlags(location: { publicPharmacy?: { catalogueEnabled?: boolean; pickupEnabled?: boolean } | null; pharmacyCapability?: { enabled?: boolean; inventoryMode?: string } | null }) {
  const catalogueEnabled = location.pharmacyCapability?.enabled !== false && location.publicPharmacy?.catalogueEnabled === true;
  return { catalogueEnabled, pickupEnabled: catalogueEnabled && location.publicPharmacy?.pickupEnabled === true && location.pharmacyCapability?.inventoryMode !== "billing_only" };
}

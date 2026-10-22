import type { FastifyRequest } from "fastify";
import { SaaSPlan } from "../../models/SaaSPlan.ts";
import { Location } from "../../models/Location.ts";
import { Organization } from "../../models/Organization.ts";
import { checkLocationAccess } from "../../utilities/tenant.ts";
import { calculateCommercialQuote, type ProductSelection } from "../../utilities/commercialQuote.ts";
import { CommandError } from "../CommandReceiptService.ts";
import { sealProductQuote, validateProductFootprint } from "./ProductActivationService.ts";

export interface ProductQuoteInput extends Omit<ProductSelection, "locations"> {
  planId: string;
  locations: Array<{ locationId: string; clinic: boolean; pharmacy: boolean }>;
}
export async function createProductQuote(req: FastifyRequest, organizationId: string, input: ProductQuoteInput) {
  const organization = await Organization.findById(organizationId).select("isActive status currency countryCode").lean();
  if (!organization || organization.isActive === false || organization.status === "inactive") throw new CommandError(403, "Organization is unavailable");
  if (organization.countryCode !== "IN" || organization.currency !== "INR") throw new CommandError(409, "Product quotes require an explicit India/INR organization");
  const plan = await SaaSPlan.findOne({ _id: input.planId, status: "active", commercialFamily: "location_products" });
  if (!plan) throw new CommandError(404, "Active product catalogue not found");
  const selections = [];
  for (const selected of input.locations) {
    const access = await checkLocationAccess(req, selected.locationId);
    if (!access.allowed) throw new CommandError(access.statusCode, access.message);
    if (access.organizationId !== organizationId) throw new CommandError(404, "Location not found");
    const location = await Location.findOne({ _id: selected.locationId, organizationId, isActive: { $ne: false } }).select("pharmacyCapability").lean();
    if (!location) throw new CommandError(404, "Location not found");
    selections.push({ ...selected, capabilityRevision: location.pharmacyCapability?.revision ?? 0 });
  }
  const quote = calculateCommercialQuote(organizationId, { ...plan.toObject(), id: plan.id }, { ...input, locations: selections });
  await validateProductFootprint(quote, null);
  return { ...quote, quoteToken: sealProductQuote(quote), purchaseAvailable: true };
}

import type { FastifyRequest } from "fastify";
import type { Types, InferSchemaType, QueryFilter } from "mongoose";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { pharmacyCapabilities, pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { loadPharmacyIssuer } from "./PharmacyDocumentService.ts";
import { resolvePublicId } from "../utilities/publicLinks.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { object, identifier, text, whole } from "../schemas/pharmacyPurchases.ts";
import { publicPharmacyFlags } from "../utilities/publicPharmacy.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";
export { publicPharmacyFlags } from "../utilities/publicPharmacy.ts";

export async function publicPharmacyLocation(slug: string) {
  const id = await resolvePublicId("location", slug);
  const location = id ? await Location.findOne({ _id: id, isActive: true, isPublished: { $ne: false } }) : null;
  const owner = location ? await Organization.exists({ _id: location.organizationId, isActive: { $ne: false }, status: { $ne: "inactive" } }) : null;
  if (!location || !owner || !publicPharmacyFlags(location).catalogueEnabled || !await isModuleEnabledForOrganization(String(location.organizationId), "pharmacy")) throw new CommandError(404, "This medicine list is not published");
  return location;
}
export const ordinaryPublicProducts = (locationId: string | Types.ObjectId): QueryFilter<InferSchemaType<typeof Medicine.schema>> => ({ locationId, deletedAt: null, scheduleType: "general", "dispensingReview.scheduleType": "general", "dispensingReview.confirmedAt": { $type: "date" }, "dispensingReview.confirmedBy": { $type: "objectId" }, "dispensingReview.reviewReference": { $type: "string", $ne: "" }, dispensingRevision: { $gte: 1 }, "unitDefinition.version": { $gte: 1 } });
export async function publicMedicinePage(req: FastifyRequest) {
  const query = object(req.query, ["search", "cursor"]), location = await publicPharmacyLocation((req.params as { slug: string }).slug);
  const search = query.search === undefined ? "" : text(query.search, "medicine search", 0, 100), prefix = new RegExp(`^${search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const rows = await Medicine.find({ ...ordinaryPublicProducts(location._id), ...(search ? { $or: [{ name: prefix }, { genericName: prefix }] } : {}), ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("name genericName strength unitDefinition").sort({ _id: 1 }).limit(26).lean();
  const items = rows.slice(0, 25), available = await MedicineBatch.distinct("medicineId", { organizationId: location.organizationId, locationId: location._id, medicineId: { $in: items.map(item => item._id) }, status: "active", lotVersion: 1, quantity: { $gt: 0 }, expiryDate: { $gt: new Date() } });
  const ids = new Set(location.pharmacyCapability?.inventoryMode === "billing_only" ? [] : available.map(String));
  return { location: { id: location.id, name: location.name }, ...publicPharmacyFlags(location), items: items.map(item => ({ id: String(item._id), name: item.name, genericName: item.genericName, strength: item.strength || "", baseUnit: item.unitDefinition!.baseUnit, unitVersion: item.unitDefinition!.version, availabilityKnown: location.pharmacyCapability?.inventoryMode !== "billing_only", available: ids.has(String(item._id)) })), nextCursor: rows.length > 25 ? String(items.at(-1)!._id) : null };
}
export async function readStorefrontSettings(req: FastifyRequest) {
  const caps = await pharmacyCapabilities(req, identifier((req.params as { locationId: string }).locationId));
  if (!await pharmacyRequestAllows(req, "manageSettings")) throw new CommandError(403, "Pharmacy settings permission is required");
  const location = await Location.findById(caps.locationId).select("publicPharmacy").lean();
  return { locationId: caps.locationId, inventoryMode: caps.inventoryMode, catalogueEnabled: location?.publicPharmacy?.catalogueEnabled === true, pickupEnabled: location?.publicPharmacy?.pickupEnabled === true && caps.inventoryMode !== "billing_only", revision: location?.publicPharmacy?.revision || 0 };
}
export async function saveStorefrontSettings(req: FastifyRequest) {
  const input = object(req.body, ["catalogueEnabled", "pickupEnabled", "expectedRevision"]);
  if (typeof input.catalogueEnabled !== "boolean" || typeof input.pickupEnabled !== "boolean" || input.pickupEnabled && !input.catalogueEnabled) throw new CommandError(400, "Publish the medicine list before enabling pickup requests");
  const expected = whole(input.expectedRevision, "storefront revision", Number.MAX_SAFE_INTEGER - 1), id = identifier((req.params as { locationId: string }).locationId);
  await withTransaction(async session => {
    requireStockTransaction(session);
    const caps = await pharmacyCapabilities(req, id);
    if (!await pharmacyRequestAllows(req, "manageSettings")) throw new CommandError(403, "Pharmacy settings permission is required");
    if (input.catalogueEnabled && (!caps.enabled || !caps.moduleEnabled || caps.commercialEntitlement === "unavailable")) throw new CommandError(409, "Enable pharmacy before publishing medicines");
    if (input.pickupEnabled && caps.inventoryMode === "billing_only") throw new CommandError(409, "Billing-only branches can publish their catalogue; stock-based pickup requests require tracked inventory");
    if (input.pickupEnabled) await loadPharmacyIssuer(caps.organizationId!, id);
    const result = await Location.findOneAndUpdate({ _id: id, organizationId: caps.organizationId, ...(expected ? { "publicPharmacy.revision": expected } : { $or: [{ publicPharmacy: { $exists: false } }, { "publicPharmacy.revision": 0 }] }) }, { $set: { publicPharmacy: { catalogueEnabled: input.catalogueEnabled, pickupEnabled: input.pickupEnabled, revision: expected + 1 } } }, { session, runValidators: true });
    if (!result) throw new CommandError(409, "Public pharmacy settings changed; reload before saving");
    await AuditLog.create({ userId: req.user!.id, organizationId: caps.organizationId, category: "ADMIN", action: "PHARMACY_STOREFRONT_UPDATED", targetModel: "Location", targetId: result._id, details: { catalogueEnabled: input.catalogueEnabled, pickupEnabled: input.pickupEnabled, revision: expected + 1 } });
  });
  return readStorefrontSettings(req);
}

import type { FastifyRequest } from "fastify";
import { PharmacyGlobalProduct } from "../models/PharmacyGlobalProduct.ts";
import { Medicine } from "../models/Medicine.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Organization } from "../models/Organization.ts";
import { identifier, object, text, whole } from "../schemas/pharmacyPurchases.ts";
import { catalogueFields, normalizeUnitDefinition } from "../utilities/medicineCatalogue.ts";
import { medicineSearchAnchor, normalizeMedicineSearch } from "../utilities/medicineSearchIndex.ts";
import { catalogueIdentity } from "../utilities/pharmacyGlobalCatalogue.ts";
import { normalizeBillingSupply, pharmacyInventoryMode } from "../utilities/pharmacyInventoryMode.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireImportScope } from "./PharmacyImportPreviewService.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError, commandHash } from "./CommandReceiptService.ts";

const projection = "name genericName composition strength dosageForm manufacturer supplierName sourceIds sourceUpdatedOn packSize barcodes provider sourceId revision source.release";
export async function searchGlobalCatalogue(req: FastifyRequest) {
  const query = object(req.query, ["locationId", "search", "barcode", "cursor", "organizationId", "organization_id"]);
  const scope = await purchaseScope(req, query.locationId);
  const organization = await Organization.findById(scope.organizationId).select("countryCode").lean();
  const search = query.search === undefined || query.search === "" ? "" : normalizeMedicineSearch(text(query.search, "search", 1, 100));
  const barcode = query.barcode === undefined || query.barcode === "" ? "" : text(query.barcode, "barcode", 1, 64);
  const hash = commandHash({ search, barcode });
  let after = "";
  if (query.cursor !== undefined) {
    const cursor = text(query.cursor, "cursor", 89, 89).split(":");
    if (cursor.length !== 2 || cursor[0] !== hash) throw new CommandError(400, "Cursor does not match this search");
    after = identifier(cursor[1]);
  }
  const terms = search.split(" ").filter(Boolean).slice(0, 12);
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const filter = { active: true, "maintenance.status": { $nin: ["withdrawn" as const, "discontinued" as const] }, ...(organization?.countryCode !== "IN" ? { provider: { $ne: "cdci" as const } } : {}), ...(after ? { _id: { $gt: after } } : {}), ...(barcode ? { barcodes: barcode } : terms.length ? {
    "search.grams": { $all: [...new Set(terms.map(medicineSearchAnchor))] }, $and: terms.map(term => ({ "search.value": { $regex: literal(term) } })) } : {}) };
  const rows = await PharmacyGlobalProduct.find(filter).select(projection).sort({ _id: 1 }).limit(26).maxTimeMS(3000).lean();
  const page = rows.slice(0, 25);
  const owned = await Medicine.find({ locationId: scope.locationId, deletedAt: null, globalProductId: { $in: page.map(row => row._id) } }).select("globalProductId").lean();
  const linked = new Set(owned.map(row => String(row.globalProductId)));
  return { items: page.map(row => ({ id: String(row._id), name: row.name, genericName: row.genericName, composition: row.composition,
    strength: row.strength, dosageForm: row.dosageForm, manufacturer: row.manufacturer, supplierName: row.supplierName, sourceIds: row.sourceIds, sourceUpdatedOn: row.sourceUpdatedOn, packSize: row.packSize, barcodes: row.barcodes,
    provider: row.provider, sourceId: row.sourceId, release: row.source?.release, revision: row.revision, alreadyAdded: linked.has(String(row._id)) })),
    nextCursor: rows.length > 25 ? `${hash}:${page[24]._id}` : null,
    sourceNotice: "Only products from locally loaded, rights-reviewed sources appear here. No external API is called during search." };
}

export async function adoptGlobalProduct(req: FastifyRequest, id: string) {
  const body = object(req.body, ["locationId", "expectedRevision", "sellingPricePaise", "unitDefinition", "category", "genericName", "billingSupply", "confirmedIdentity", "organizationId", "organization_id"]);
  const scope = await requireImportScope(req, body.locationId, "catalogue");
  const productId = identifier(id), expectedRevision = whole(body.expectedRevision, "source revision");
  if (body.confirmedIdentity !== true) throw new CommandError(400, "Confirm the exact medicine identity and pack conversion");
  return withTransaction(async session => {
    requireStockTransaction(session);
    // Use the same organization -> branch lock order as reviewed imports.
    const organization = await Organization.findOneAndUpdate({ _id: scope.organizationId, isActive: { $ne: false }, status: { $ne: "inactive" } }, { $inc: { __v: 1 } }, { session, returnDocument: "after", timestamps: false }).select("countryCode");
    if (!organization) throw new CommandError(409, "An active organization is required to add catalogue references");
    await pinActivePharmacyLocation(scope.locationId, session);
    // This shared branch fence also serializes imports and ordinary product creation.
    const existing = await Medicine.findOne({ locationId: scope.locationId, deletedAt: null, globalProductId: productId }).session(session);
    if (existing) return { medicine: existing.toJSON(), reused: true };
    // Pin the reviewed reference in this transaction: a simultaneous withdrawal
    // or provider revision must conflict/retry, rather than passing a stale read.
    const source = await PharmacyGlobalProduct.findOneAndUpdate({ _id: productId, active: true, revision: expectedRevision, "maintenance.status": { $nin: ["withdrawn" as const, "discontinued" as const] } }, { $inc: { __v: 1 } }, { session, returnDocument: "after", timestamps: false });
    if (!source) throw new CommandError(409, "Catalogue product changed or was withdrawn; search and review it again");
    if (source.provider === "cdci" && organization.countryCode !== "IN") throw new CommandError(403, "CDCI catalogue references are limited to reviewed use within India");
    const price = whole(body.sellingPricePaise, "branch selling price") / 100;
    const mode = await pharmacyInventoryMode(scope.locationId, session);
    const billingSupply = mode.mode === "billing_only" ? normalizeBillingSupply(body.billingSupply) : undefined;
    if (mode.mode !== "billing_only" && body.billingSupply !== undefined) throw new CommandError(400, "Tracked branches record batches through stock receipt, not catalogue adoption");
    if (billingSupply && body.sellingPricePaise > billingSupply.mrpPaise) throw new CommandError(400, "Selling price cannot exceed the printed MRP");
    const unitDefinition = normalizeUnitDefinition(body.unitDefinition, 1);
    if (!body.category) throw new CommandError(400, "Select the actual medicine form");
    const genericName = source.genericName || source.composition || text(body.genericName, "generic/formulation", 1, 500);
    const fields = catalogueFields({ name: source.name, genericName, manufacturer: source.manufacturer, strength: source.strength, category: body.category, barcodes: source.barcodes });
    if (source.barcodes.length && await Medicine.exists({ locationId: scope.locationId, deletedAt: null, barcodes: { $in: source.barcodes } }).session(session)) throw new CommandError(409, "A branch product already uses this barcode. Review that existing product; no price or stock was changed.");
    const candidates = await Medicine.find({ locationId: scope.locationId, deletedAt: null, "searchIndex.name.grams": medicineSearchAnchor(normalizeMedicineSearch(source.name)), "searchIndex.name.value": normalizeMedicineSearch(source.name) }).select("name genericName manufacturer strength category unitDefinition").limit(100).session(session).lean();
    if (candidates.length === 100 || candidates.some(row => catalogueIdentity(row) === catalogueIdentity({ ...fields, unitDefinition }))) throw new CommandError(409, "This identity may already exist in the branch. Review the existing product before creating another.");
    const medicine = await createWithSession<InstanceType<typeof Medicine>>(Medicine, { ...fields, locationId: scope.locationId, unitDefinition, price, stockQuantity: 0, ...(billingSupply ? { billingSupply } : {}),
      globalProductId: source._id, globalProductRevision: source.revision,
      catalogueSource: { provider: source.provider, sourceId: source.sourceId, release: source.source!.release, rowSha256: source.source!.rowSha256 } }, session);
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_GLOBAL_PRODUCT_ADOPTED", category: "ADMIN", targetModel: "Medicine", targetId: medicine._id,
      details: { globalProductId: String(source._id), revision: source.revision, provider: source.provider, sourceId: source.sourceId, stockQuantity: 0 } }, session);
    return { medicine: medicine.toJSON(), reused: false };
  }, { writeConcern: { w: "majority" } });
}

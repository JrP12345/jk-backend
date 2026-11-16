import type { FastifyRequest } from "fastify";
import { PharmacyPurchaseCsvFormat, PharmacySupplierItemMapping } from "../models/PharmacyPurchaseCsvMapping.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { object, whole } from "../schemas/pharmacyPurchases.ts";
import { parsePharmacyCsv } from "../utilities/pharmacyCsv.ts";
import { purchaseCsvFormatId, purchaseCsvFormatKey, purchaseCsvItemId } from "../utilities/pharmacyPurchaseCsvMapping.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { commandHash, CommandError } from "./CommandReceiptService.ts";
import { scopedParty } from "./PharmacyPurchaseDraftService.ts";
import { previewPurchaseCsv } from "./PharmacyPurchaseCsvService.ts";

/** Optional preferences only. No invoice, payable, stock or payment writes. */
export async function rememberPurchaseCsvMapping(req: FastifyRequest) {
  const body = object(req.body, ["locationId", "supplierId", "csv", "mapping", "matches", "priceBasis", "expectedRevision", "confirmedMappings"]);
  const expectedRevision = whole(body.expectedRevision, "saved mapping revision", Number.MAX_SAFE_INTEGER - 1);
  if (body.confirmedMappings !== true) throw new CommandError(400, "Confirm the previewed medicine identities and units before remembering mappings");
  return withTransaction(async session => {
    requireStockTransaction(session);
    const { scope, party } = await scopedParty(req, body.supplierId, body.locationId);
    if (party.archived || !party.kinds.includes("supplier")) throw new CommandError(409, "Choose an active supplier before remembering mappings");
    const locked = await PharmacyParty.updateOne({ _id: party._id, organizationId: scope.organizationId, locationIds: scope.locationId, revision: party.revision, archived: false }, { $inc: { __v: 1 } }, { session, timestamps: false });
    if (locked.matchedCount !== 1) throw new CommandError(409, "Supplier changed; reload before remembering mappings");
    const preview = await previewPurchaseCsv(req, true);
    if (preview.rows.some(row => row.error !== null)) throw new CommandError(409, "CSV medicines or source values need attention. Preview and correct every row before remembering mappings");
    // Fastify's secure JSON parser supplies null-prototype objects. Adapt only
    // the validated field map to Mongoose's Map input, which expects a plain object.
    const mapping = Object.fromEntries(Object.entries(body.mapping));
    const formatKey = purchaseCsvFormatKey(parsePharmacyCsv(body.csv).headers), supplierId = String(party._id);
    const id = purchaseCsvFormatId(scope.organizationId, scope.locationId, supplierId, formatKey);
    const items = [...new Map(preview.rows.map(row => [row.sourceValue, { sourceValue: row.sourceValue, medicineId: row.product!.id, identityHash: row.product!.identityHash }])).values()].sort((a, b) => a.sourceValue < b.sourceValue ? -1 : a.sourceValue > b.sourceValue ? 1 : 0);
    const lastSaveHash = commandHash({ expectedRevision, actorId: scope.actorId, mapping, priceBasis: body.priceBasis, items });
    const current = await PharmacyPurchaseCsvFormat.findById(id).session(session).lean();
    const result = (revision: number) => ({ locationId: scope.locationId, supplierId, formatKey, revision });
    if (current && current.revision === expectedRevision + 1 && current.lastSaveHash === lastSaveHash && String(current.updatedBy) === scope.actorId) return result(current.revision);
    if ((current?.revision || 0) !== expectedRevision) throw new CommandError(409, "Saved supplier mappings changed. Choose the file again to reload them before remembering changes; your draft is unchanged");
    const revision = expectedRevision + 1;
    if (current) {
      const update = await PharmacyPurchaseCsvFormat.updateOne({ _id: id, revision: expectedRevision }, { $set: { mapping, priceBasis: body.priceBasis, lastSaveHash, updatedBy: scope.actorId }, $inc: { revision: 1 } }, { session, runValidators: true });
      if (update.matchedCount !== 1) throw new CommandError(409, "Saved supplier mappings changed; choose the file again before remembering changes");
    } else await createWithSession(PharmacyPurchaseCsvFormat, { _id: id, organizationId: scope.organizationId, locationId: scope.locationId, supplierId,
      formatKey, mapping, priceBasis: body.priceBasis, revision, lastSaveHash, createdBy: scope.actorId, updatedBy: scope.actorId }, session);
    await PharmacySupplierItemMapping.bulkWrite(items.map(item => ({ updateOne: {
      filter: { _id: purchaseCsvItemId(id, body.mapping.source, item.sourceValue) },
      update: { $set: { formatId: id, sourceColumn: body.mapping.source, ...item, updatedBy: scope.actorId } }, upsert: true,
    } })), { session });
    await createWithSession(AuditLog, { userId: scope.actorId, organizationId: scope.organizationId, action: "PHARMACY_PURCHASE_CSV_MAPPINGS_SAVED", targetModel: "PharmacyParty", targetId: party._id,
      category: "ADMIN", details: { locationId: scope.locationId, formatKey, revision, matchedItemCount: items.length } }, session);
    await pinActivePharmacyLocation(scope.locationId, session);
    return result(revision);
  });
}

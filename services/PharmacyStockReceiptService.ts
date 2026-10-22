import type { ClientSession } from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { CommandError, executeRecordedCommand } from "./CommandReceiptService.ts";
import { appendStockMovement } from "./PharmacyStockMovementService.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction, stockRevisionFilter } from "../utilities/pharmacyInventory.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { lotExpiry, normalizeStockReceipt, receiptQuantity, validateCapturedLot, type StockReceiptInput } from "../utilities/pharmacyLot.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";

export interface StockReceiptAuthority { organizationId: string; locationId: string; actorId: string }
const scopeKey = (authority: StockReceiptAuthority) => `pharmacy-stock-receipt:${authority.organizationId}:${authority.locationId}`;

/** Immutable received result, not the lot's later remaining balance. Current authority is checked by the route. */
export async function recoverPharmacyStockReceipt(authority: StockReceiptAuthority, key: string) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new CommandError(400, "A stable receipt reference is required");
  const saved = await OperationReceipt.findOne({ scope: scopeKey(authority), key }).select("+responseCiphertext").lean();
  if (!saved?.resultId || !saved.responseCiphertext) throw new CommandError(404, "No committed stock receipt is visible. Keep the same reference and check again.");
  let snapshot: any;
  try { snapshot = JSON.parse(decryptField(saved.responseCiphertext)); }
  catch { throw new CommandError(409, "Stock receipt evidence needs review. Keep the same reference."); }
  if (snapshot.actorId !== authority.actorId) throw new CommandError(404, "No committed stock receipt is visible for this operator");
  if (snapshot.version !== 1 || snapshot.organizationId !== authority.organizationId || snapshot.locationId !== authority.locationId || snapshot.key !== key ||
      snapshot.data?.batchId !== String(saved.resultId)) throw new CommandError(409, "Stock receipt evidence needs review. Keep the same reference.");
  return snapshot.data;
}

export async function receivePharmacyStock(authority: StockReceiptAuthority, key: string, rawInput: StockReceiptInput) {
  const input = normalizeStockReceipt(rawInput);
  if (input.locationId !== authority.locationId) throw new CommandError(404, "Medicine not found in selected location");
  if (!await OperationReceipt.exists({ scope: scopeKey(authority), key })) await requireReceiptIndexes(input);
  const command = await executeRecordedCommand(scopeKey(authority), key, { version: 1, actorId: authority.actorId, ...input }, () => withTransaction(async session => {
    const data = await receivePharmacyStockInTransaction(authority, key, input, session);
    const saved = await OperationReceipt.updateOne({ scope: scopeKey(authority), key }, { $set: { responseCiphertext: JSON.stringify({ version: 1, ...authority, key, data }) } }).session(session);
    if (saved.matchedCount !== 1) throw new CommandError(409, "Receipt reservation changed; retry the same reference");
    await pinActivePharmacyLocation(input.locationId, session);
    return data.batchId;
  }), { writeConcern: { w: "majority" } });
  return { ...await recoverPharmacyStockReceipt(authority, key), replayed: command.replayed };
}

/** Evaluate real index readiness without creating or removing an index. Never called in a transaction. */
export async function requireReceiptIndexes(input: StockReceiptInput) {
  const indexes = await MedicineBatch.collection.listIndexes().toArray();
  const identity = indexes.some(index => index.unique === true && JSON.stringify(index.key) === JSON.stringify({ organizationId: 1, locationId: 1, receiptLineId: 1 }) && index.partialFilterExpression?.lotVersion === 1);
  if (!identity) throw new CommandError(503, "Prepare the reviewed receipt identity index before explicit receiving");
  const legacyLabel = indexes.some(index => index.unique === true && Object.keys(index.key).length === 3 && ["medicineId", "locationId", "batchNumber"].every(key => index.key[key] === 1));
  if (legacyLabel && await MedicineBatch.exists({ medicineId: input.medicineId, locationId: input.locationId, batchNumber: input.batchNumber })) throw new CommandError(409, "This database retains legacy batch-label uniqueness. Review T25 reconciliation before repeated printed-batch receipts.");
}

export interface PurchaseLotSource { purchaseId: string; purchaseLineId: string; receiptId: string }
/** One reviewed opening may contain several lots of a product, committed atomically.
 * The initial empty/no-history baseline is checked once; only this call's lot identities
 * may exist as subsequent opening lines are appended in the same transaction. */
export async function receivePharmacyOpeningGroup(authority: StockReceiptAuthority, key: string, rawInputs: StockReceiptInput[], session: ClientSession | null) {
  requireStockTransaction(session);
  const inputs = rawInputs.map(normalizeStockReceipt), first = inputs[0];
  if (!first || inputs.length > 200 || inputs.some(input => input.kind !== "opening" || input.medicineId !== first.medicineId || input.locationId !== authority.locationId) ||
      new Set(inputs.map(input => input.receiptLineId)).size !== inputs.length) throw new CommandError(400, "Opening lot group must identify one product and distinct actual source rows");
  const medicine = await Medicine.findOne({ _id: first.medicineId, locationId: authority.locationId, deletedAt: null }).session(session);
  if (!medicine || medicine.stockQuantity !== 0 || await MedicineBatch.exists({ medicineId: first.medicineId }).session(session) || await StockMovement.exists({ medicineId: first.medicineId }).session(session)) throw new CommandError(409, "Opening import requires an empty product with no prior stock history");
  const permitted = new Set(inputs.map(input => input.receiptLineId)), results = [];
  for (const input of inputs) results.push(await receivePharmacyStockInTransaction(authority, key, input, session, undefined, permitted));
  await pinActivePharmacyLocation(authority.locationId, session);
  return results;
}

export async function receivePharmacyStockInTransaction(authority: StockReceiptAuthority, key: string, rawInput: StockReceiptInput, session: ClientSession | null, source?: { purchaseSource: PurchaseLotSource; hsnCode: string; gstRate: number; unitSnapshot: { version: number; baseUnit: string; packUnit: string; unitsPerPack: number } }, openingGroupLineIds?: ReadonlySet<string>) {
  const input = normalizeStockReceipt(rawInput);
  if (input.locationId !== authority.locationId) throw new CommandError(404, "Receipt location differs from authority");
  requireStockTransaction(session);
  const location = await Location.findOne({ _id: input.locationId, organizationId: authority.organizationId, isActive: { $ne: false } }).session(session);
  if (!location) throw new CommandError(404, "Location not found");
  const organization = await Organization.findById(authority.organizationId).select("currency countryCode timezone").session(session);
  if (organization?.currency !== "INR" || organization.countryCode !== "IN") throw new CommandError(409, "Stock receipt paise amounts require an explicitly configured India/INR organization");
  const medicine = await Medicine.findOne({ _id: input.medicineId, locationId: input.locationId, deletedAt: null }).session(session);
  if (!medicine) throw new CommandError(404, "Medicine not found");
  const unit = medicine.unitDefinition;
  if (!unit) throw new CommandError(409, "Review and configure units on an empty product before using explicit stock receipts");
  if (source && (["version", "baseUnit", "packUnit", "unitsPerPack"] as const).some(field => unit[field] !== source.unitSnapshot[field])) throw new CommandError(409, "Received product units differ from the posted purchase snapshot");
  const quantity = receiptQuantity(input, unit);
  if (!Number.isSafeInteger(medicine.stockQuantity) || medicine.stockQuantity < 0 || !Number.isSafeInteger(medicine.stockQuantity + quantity)) throw new CommandError(409, "Stock quantity needs inventory review");
  const revision = stockRevisionFilter(medicine.stockRevision ?? 0);
  const expiry = lotExpiry(input.expiry, location.timezone || organization.timezone || "Asia/Kolkata");
  const receivedAt = new Date();
  if (expiry.cutoff <= receivedAt) throw new CommandError(400, "Expired stock cannot enter this saleable receipt path");
  if (await MedicineBatch.exists({ organizationId: authority.organizationId, locationId: input.locationId, receiptLineId: input.receiptLineId }).session(session)) throw new CommandError(409, "Receipt line already exists. Recover the original request reference; do not receive it again.");
  const prior = await MedicineBatch.find({ medicineId: input.medicineId }).limit(5001).session(session);
  if (prior.length > 5000) throw new CommandError(409, "Lot history exceeds the receipt review bound");
  const continuingOpeningGroup = openingGroupLineIds?.has(input.receiptLineId) && prior.length > 0 && prior.every(lot =>
    lot.receiptKind === "opening" && openingGroupLineIds.has(lot.receiptLineId!) && lot.quantity === lot.receivedQuantity);
  if (input.kind === "opening" && !continuingOpeningGroup && (medicine.stockQuantity !== 0 || prior.length || await StockMovement.exists({ medicineId: medicine._id }).session(session))) throw new CommandError(409, "Opening receipt requires a new empty product with no stock history; reconcile existing stock separately");
  let batchQuantity = 0;
  for (const lot of prior) {
    if (lot.lotVersion !== 1 || String(lot.locationId) !== input.locationId) throw new CommandError(409, "Existing lot units/ownership need reviewed reconciliation before explicit receiving");
    validateCapturedLot(lot, unit, authority.organizationId);
    batchQuantity += lot.quantity;
  }
  if (!Number.isSafeInteger(batchQuantity) || batchQuantity !== medicine.stockQuantity) throw new CommandError(409, "Aggregate and lot stock do not reconcile; no opening difference is inferred");
  const batch = await createWithSession<InstanceType<typeof MedicineBatch>>(MedicineBatch, {
    organizationId: authority.organizationId, locationId: input.locationId, medicineId: input.medicineId,
    lotVersion: 1, receiptLineId: input.receiptLineId, receiptKind: input.kind, receivedAt, receivedQuantity: quantity,
    unitSnapshot: { version: unit.version, baseUnit: unit.baseUnit, packUnit: unit.packUnit, unitsPerPack: unit.unitsPerPack },
    costBasis: { totalPaise: input.purchaseTotalPaise, receivedBaseUnits: quantity, currency: "INR" },
    sellingPricePaise: input.sellingPricePaise, ...(input.mrpPaise !== undefined ? { mrpPaise: input.mrpPaise, mrp: input.mrpPaise / 100 } : {}),
    openingSourceReference: input.openingSourceReference, expirySnapshot: expiry,
    batchNumber: input.batchNumber, expiryDate: expiry.cutoff, quantity,
    purchaseCost: input.purchaseTotalPaise / quantity / 100, sellingPrice: input.sellingPricePaise / 100,
    hsnCode: source?.hsnCode ?? medicine.hsnCode, gstRate: source?.gstRate ?? medicine.gstRate, status: "active",
    ...(source ? { purchaseSource: source.purchaseSource } : {}),
  }, session);
  const updated = await Medicine.findOneAndUpdate({ _id: medicine._id, locationId: input.locationId, deletedAt: null, stockQuantity: medicine.stockQuantity, ...revision }, {
    $inc: { stockQuantity: quantity, stockRevision: 1 }, $set: { stockLedgerStartedAt: medicine.stockLedgerStartedAt || receivedAt },
  }, { session, returnDocument: "after" });
  if (!updated) throw new CommandError(409, "Stock changed; reload before receiving");
  const movement = await appendStockMovement(medicine, input.kind === "opening" ? "opening_receipt" : "receipt", updated.stockQuantity,
    [{ batchId: batch._id, beforeQuantity: 0, afterQuantity: quantity, quantityDelta: quantity }], session, { actorId: authority.actorId, clientRequestId: key, notes: input.openingSourceReference, purchaseSource: source?.purchaseSource });
  await createWithSession(AuditLog, { userId: authority.actorId, organizationId: authority.organizationId, action: "PHARMACY_STOCK_RECEIPT", targetModel: "MedicineBatch", targetId: batch._id,
    details: { receiptLineId: input.receiptLineId, kind: input.kind, quantity, movementId: movement._id, sourceReference: input.openingSourceReference, purchaseSource: source?.purchaseSource } }, session);
  const data = { batchId: String(batch._id), medicineId: input.medicineId, locationId: input.locationId, receiptLineId: input.receiptLineId, kind: input.kind, receivedQuantity: quantity,
    movementId: String(movement._id), revision: movement.revision, batch: batch.toJSON(), requestKey: key };
  return data;
}

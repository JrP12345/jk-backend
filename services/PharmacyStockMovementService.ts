import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { requestContextStore } from "../utilities/context.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { PharmacyInventoryError, requireStockTransaction, stockRevisionFilter } from "../utilities/pharmacyInventory.ts";
import { executeRecordedCommand } from "./CommandReceiptService.ts";

interface StockSnapshot {
  _id: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
  stockQuantity: number;
  stockRevision?: number;
  stockLedgerStartedAt?: Date | null;
}
export interface StockAllocation {
  batchId: string | mongoose.Types.ObjectId;
  beforeQuantity: number;
  afterQuantity: number;
  quantityDelta: number;
}

/** A prospective aggregate checkpoint; it makes no claim about historical lot provenance. */
export async function appendStockMovement(
  medicine: StockSnapshot,
  kind: "opening_receipt" | "receipt" | "dispense" | "adjustment" | "sales_return" | "purchase_return" | "transfer_out" | "transfer_in" | "transfer_return",
  afterQuantity: number,
  allocations: StockAllocation[],
  session: mongoose.ClientSession | null,
  options: { reason?: StockAdjustmentInput["reason"]; notes?: string; actorId?: string; clientRequestId?: string; returnId?: string; purchaseSource?: { purchaseId: string; purchaseLineId: string; receiptId: string }; transferSource?: { transferId: string; eventId: string } } = {},
) {
  requireStockTransaction(session);
  const location = await Location.findOne({ _id: medicine.locationId, isActive: { $ne: false } }).session(session);
  if (!location) throw new PharmacyInventoryError("Location not found", 404);
  const revision = medicine.stockRevision ?? 0;
  stockRevisionFilter(revision);
  const actorId = options.actorId || requestContextStore.getStore()?.userId;
  const common = { organizationId: location.organizationId, locationId: medicine.locationId,
    medicineId: medicine._id, actorId };
  const stockMode = allocations.length > 0 ? "batch" : "legacy_aggregate";
  if (!medicine.stockLedgerStartedAt) {
    const structured = await MedicineBatch.exists({ medicineId: medicine._id,
      ...(["opening_receipt", "receipt"].includes(kind) ? { _id: { $nin: allocations.map(lot => lot.batchId) } } : {}) }).session(session);
    await createWithSession(StockMovement, { ...common, kind: "opening_baseline", reason: "opening_baseline",
      disposition: "opening_checkpoint", stockMode: structured ? "batch" : "legacy_aggregate", revision,
      beforeQuantity: medicine.stockQuantity, afterQuantity: medicine.stockQuantity, quantityDelta: 0 }, session);
  }
  const reason = options.reason || kind;
  return createWithSession<InstanceType<typeof StockMovement>>(StockMovement, {
    ...common, kind, stockMode, revision: revision + 1, beforeQuantity: medicine.stockQuantity, afterQuantity,
    quantityDelta: afterQuantity - medicine.stockQuantity, allocations, reason,
    disposition: kind === "adjustment" ? (["damaged", "expired"].includes(reason) ? "write_off" : "count_correction") : kind === "sales_return" ? "quarantine_return" : kind === "purchase_return" ? "supplier_return" : kind,
    notes: options.notes, clientRequestId: options.clientRequestId, purchaseSource: options.purchaseSource, returnId: options.returnId, transferSource: options.transferSource,
  }, session);
}

export interface StockAdjustmentInput {
  medicineId: string;
  batchId?: string;
  newQuantity: number;
  expectedQuantity: number;
  expectedRevision: number;
  clientRequestId: string;
  reason: "physical_audit" | "damaged" | "expired" | "restock" | "other";
  notes?: string;
}

export async function adjustMedicineStock(
  input: StockAdjustmentInput,
  authority: { organizationId: string; locationId: string; actorId: string },
) {
  if (![input.newQuantity, input.expectedQuantity, input.expectedRevision].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new PharmacyInventoryError("Count quantities and revision must be non-negative safe integers", 400);
  }
  if (!["physical_audit", "damaged", "expired", "restock", "other"].includes(input.reason) ||
      (input.notes !== undefined && (typeof input.notes !== "string" || input.notes.length > 500)) ||
      (input.reason === "other" && !input.notes?.trim())) {
    throw new PharmacyInventoryError("A valid adjustment reason and explanatory notes for 'other' are required", 400);
  }
  const payload = { ...input, notes: input.notes?.trim() || null, actorId: authority.actorId };
  const scope = `pharmacy-stock-adjustment:${authority.organizationId}:${authority.locationId}:${input.medicineId}`;
  const command = await executeRecordedCommand(scope, input.clientRequestId, payload, () => withTransaction(async session => {
    requireStockTransaction(session);
    const medicine = await Medicine.findOne({ _id: input.medicineId, locationId: authority.locationId, deletedAt: null }).session(session);
    if (!medicine) throw new PharmacyInventoryError("Medicine not found", 404);
    const location = await Location.findOne({ _id: authority.locationId, organizationId: authority.organizationId,
      isActive: { $ne: false } }).session(session);
    if (!location) throw new PharmacyInventoryError("Location not found", 404);
    if (!Number.isSafeInteger(medicine.stockQuantity) || medicine.stockQuantity < 0 ||
        (medicine.stockRevision ?? 0) !== input.expectedRevision) {
      throw new PharmacyInventoryError("Stock changed; reload and recount before adjusting");
    }
    const structured = await MedicineBatch.exists({ medicineId: medicine._id }).session(session);
    if (structured && !input.batchId) throw new PharmacyInventoryError("Structured stock requires a selected batch");
    if (!structured && input.batchId) throw new PharmacyInventoryError("Batch not found", 404);
    const batch = input.batchId ? await MedicineBatch.findOne({ _id: input.batchId, medicineId: medicine._id,
      locationId: medicine.locationId }).session(session) : null;
    if (input.batchId && !batch) throw new PharmacyInventoryError("Batch not found", 404);
    const oldQuantity = batch ? batch.quantity : medicine.stockQuantity;
    if (!Number.isSafeInteger(oldQuantity) || oldQuantity < 0 || oldQuantity !== input.expectedQuantity) {
      throw new PharmacyInventoryError("Stock changed; reload and recount before adjusting");
    }
    const delta = input.newQuantity - oldQuantity;
    const afterQuantity = medicine.stockQuantity + delta;
    if (!Number.isSafeInteger(afterQuantity) || afterQuantity < 0) throw new PharmacyInventoryError("Adjustment exceeds available stock or safe quantity limits");
    if ((["damaged", "expired"].includes(input.reason) && delta >= 0) || (input.reason === "restock" && delta <= 0)) {
      throw new PharmacyInventoryError("Write-offs must reduce stock and restock must increase stock", 400);
    }
    const expiry = batch ? batch.expiryDate : medicine.expiryDate;
    if (delta > 0 && (!expiry || !Number.isFinite(new Date(expiry).getTime()) || new Date(expiry) <= new Date() || batch?.status === "expired")) {
      throw new PharmacyInventoryError("Cannot increase stock with expired or unknown expiry; review inventory");
    }
    if (batch && !["active", "expired", "depleted"].includes(batch.status)) throw new PharmacyInventoryError("Batch requires inventory review");
    const allocations: StockAllocation[] = [];
    if (batch) {
      const totals = await MedicineBatch.aggregate([
        { $match: { medicineId: medicine._id } },
        { $group: { _id: "$locationId", quantity: { $sum: "$quantity" }, invalid: { $sum: { $cond: [{ $and: [
          { $isNumber: "$quantity" }, { $gte: ["$quantity", 0] }, { $lte: ["$quantity", Number.MAX_SAFE_INTEGER] },
          { $eq: [{ $cond: [{ $isNumber: "$quantity" }, { $mod: ["$quantity", 1] }, null] }, 0] },
        ] }, 0, 1] } } } },
      ]).session(session);
      if (totals.length !== 1 || totals[0].invalid !== 0 || String(totals[0]._id) !== authority.locationId || totals[0].quantity !== medicine.stockQuantity) {
        throw new PharmacyInventoryError("Batch and aggregate stock do not reconcile; review inventory");
      }
      const status = input.newQuantity === 0 ? "depleted"
        : batch.status === "expired" || new Date(batch.expiryDate) <= new Date() ? "expired" : "active";
      const changed = await MedicineBatch.findOneAndUpdate({ _id: batch._id, medicineId: medicine._id,
        locationId: medicine.locationId, quantity: oldQuantity }, { $inc: { quantity: delta }, $set: { status } }, { session });
      if (!changed) throw new PharmacyInventoryError("Batch changed; reload and recount before adjusting");
      allocations.push({ batchId: batch._id, beforeQuantity: oldQuantity, afterQuantity: input.newQuantity, quantityDelta: delta });
    }
    const updated = await Medicine.findOneAndUpdate({ _id: medicine._id, locationId: medicine.locationId, deletedAt: null,
      stockQuantity: medicine.stockQuantity, ...stockRevisionFilter(input.expectedRevision) }, {
      $inc: { stockQuantity: delta, stockRevision: 1 },
      $set: { stockLedgerStartedAt: medicine.stockLedgerStartedAt || new Date() },
    }, { session, returnDocument: "after" });
    if (!updated) throw new PharmacyInventoryError("Stock changed; reload and recount before adjusting");
    const movement = await appendStockMovement(medicine, "adjustment", afterQuantity, allocations, session, {
      reason: input.reason, notes: input.notes?.trim(), actorId: authority.actorId, clientRequestId: input.clientRequestId,
    });
    await createWithSession(AuditLog, { organizationId: authority.organizationId, userId: authority.actorId,
      action: "MEDICINE_STOCK_ADJUSTMENT", targetId: medicine._id, targetModel: "Medicine",
      details: { movementId: movement._id, oldQuantity, newQuantity: input.newQuantity, adjustmentDelta: delta,
        revision: movement.revision, reason: input.reason, notes: input.notes?.trim() || null } }, session);
    await pinActivePharmacyLocation(authority.locationId, session, delta > 0);
    return String(movement._id);
  }));
  const movement = await StockMovement.findOne({ _id: command.resultId, organizationId: authority.organizationId,
    locationId: authority.locationId, medicineId: input.medicineId, kind: "adjustment" }).lean();
  if (!movement) throw new PharmacyInventoryError("Stock adjustment result unavailable; request review");
  return { movement, replayed: command.replayed };
}

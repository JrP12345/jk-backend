import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { prepareRestrictedSupply, recordRestrictedSupply, type RestrictedSupplyContext } from "./PharmacyRestrictedSupply.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { PharmacyInventoryError, requireStockTransaction, stockRevisionFilter } from "../utilities/pharmacyInventory.ts";
import { appendStockMovement } from "./PharmacyStockMovementService.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { validateCapturedLot } from "../utilities/pharmacyLot.ts";
import { Location } from "../models/Location.ts";
export { PharmacyInventoryError } from "../utilities/pharmacyInventory.ts";

export interface DispenseAuditContext extends RestrictedSupplyContext {
  organizationId?: string | mongoose.Types.ObjectId;
  patientId?: string | mongoose.Types.ObjectId;
  patientName?: string;
  patientAddress?: string;
  patientPhone?: string;
  doctorId?: string | mongoose.Types.ObjectId;
  doctorName?: string;
  doctorRegNumber?: string;
  prescriptionId?: string | mongoose.Types.ObjectId;
  encounterId?: string | mongoose.Types.ObjectId;
  invoiceId?: string | mongoose.Types.ObjectId;
  dispensedBy?: string | mongoose.Types.ObjectId;
  dispensedByName?: string;
}

export interface BatchAddInput {
  medicineId: string;
  locationId: string;
  batchNumber: string;
  expiryDate: string | Date;
  quantity: number;
  purchaseCost: number;
  sellingPrice: number;
  mrp?: number;
  hsnCode?: string;
  gstRate?: number;
  unlinkedInwardReason?: string;
}

export async function addBatchToMedicine(input: BatchAddInput): Promise<any> {
  const expDate = new Date(input.expiryDate);
  if (isNaN(expDate.getTime())) {
    throw new PharmacyInventoryError("Invalid expiration date", 400);
  }

  const batchNumber = typeof input.batchNumber === "string" ? input.batchNumber.trim() : "";
  if (!batchNumber) throw new PharmacyInventoryError("Batch number is required", 400);
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new PharmacyInventoryError("Quantity must be a positive safe integer", 400);
  if (!Number.isFinite(input.purchaseCost) || input.purchaseCost < 0 || !Number.isFinite(input.sellingPrice) || input.sellingPrice < 0) {
    throw new PharmacyInventoryError("Batch prices must be non-negative finite numbers", 400);
  }
  if (input.mrp !== undefined && (!Number.isFinite(input.mrp) || input.mrp < 0)) {
    throw new PharmacyInventoryError("MRP must be a non-negative finite number", 400);
  }
  return withTransaction(async (session) => {
    requireStockTransaction(session);
    const queryOptions = session ? { session } : undefined;
    const medicine = await Medicine.findOne({ _id: input.medicineId, deletedAt: null }, null, queryOptions);
    if (!medicine) {
      throw new PharmacyInventoryError("Medicine record not found", 404);
    }
    if (medicine.locationId.toString() !== input.locationId) {
      throw new PharmacyInventoryError("Medicine is not assigned to the selected location", 404);
    }
    if (!Number.isSafeInteger(medicine.stockQuantity) || medicine.stockQuantity < 0 ||
        !Number.isSafeInteger(medicine.stockQuantity + input.quantity)) {
      throw new PharmacyInventoryError("Resulting stock must be a non-negative safe integer; review inventory");
    }
    const revisionFilter = stockRevisionFilter(medicine.stockRevision ?? 0);

    if (await MedicineBatch.exists({ medicineId: medicine._id, lotVersion: 1 }).session(session)) throw new PharmacyInventoryError("Use explicit stock receipts for this product; legacy inward cannot mix with captured lot units");

    const duplicateBatch = await MedicineBatch.findOne(
      { medicineId: input.medicineId, locationId: input.locationId, batchNumber },
      null,
      queryOptions
    );
    if (duplicateBatch) throw new PharmacyInventoryError("A batch with this number already exists for the medicine");

    const batch = await createWithSession(
      MedicineBatch,
      {
        medicineId: input.medicineId,
        locationId: input.locationId,
        batchNumber,
        expiryDate: expDate,
        quantity: input.quantity,
        purchaseCost: input.purchaseCost,
        sellingPrice: input.sellingPrice,
        mrp: input.mrp,
        hsnCode: input.hsnCode || medicine.get("hsnCode") || "3004",
        gstRate: input.gstRate !== undefined ? input.gstRate : (medicine.get("gstRate") ?? 5),
        status: expDate < new Date() ? "expired" : "active",
      },
      session
    );

    const updated = await Medicine.findOneAndUpdate(
      { _id: input.medicineId, locationId: input.locationId, deletedAt: null,
        stockQuantity: medicine.stockQuantity, ...revisionFilter },
      { $inc: { stockQuantity: input.quantity, stockRevision: 1 },
        $set: { stockLedgerStartedAt: medicine.stockLedgerStartedAt || new Date() } },
      { returnDocument: "after", ...queryOptions }
    );
    if (!updated) throw new PharmacyInventoryError("Medicine unavailable or stock changed; review inventory");
    await appendStockMovement(medicine, "receipt", medicine.stockQuantity + input.quantity, [{
      batchId: batch._id, beforeQuantity: 0, afterQuantity: input.quantity, quantityDelta: input.quantity,
    }], session, { notes: input.unlinkedInwardReason });

    await pinActivePharmacyLocation(input.locationId, session);
    return batch;
  });
}

/**
 * Dispense medicine using FEFO (First-Expired, First-Out) strategy.
 * Automatically selects nearest-expiring non-expired active batch.
 */
export async function dispenseMedicineFEFO(
  medicineId: string,
  locationId: string,
  dispenseQuantity: number,
  existingSession?: mongoose.ClientSession | null,
  auditContext?: DispenseAuditContext
): Promise<{ dispensedBatches: Array<{ batchId: string; batchNumber: string; quantity: number }>; totalCost: number;
  pricedAllocations: Array<{ batchId?: string; batchNumber: string; expiryDate: Date; quantity: number; unitPrice: number; hsnCode: string; gstRate?: number }> }> {
  if (!Number.isSafeInteger(dispenseQuantity) || dispenseQuantity <= 0) {
    throw new PharmacyInventoryError("Dispense quantity must be a positive safe integer", 400);
  }

  const execute = async (session: mongoose.ClientSession | null) => {
    requireStockTransaction(session);
    const queryOptions = session ? { session } : undefined;
    const medicine = await Medicine.findOne({ _id: medicineId, deletedAt: null }, null, queryOptions);
    if (!medicine) {
      throw new PharmacyInventoryError("Medicine record not found", 404);
    }
    if (medicine.locationId.toString() !== locationId) {
      throw new Error("Medicine is not assigned to the selected location");
    }
    if (!Number.isSafeInteger(medicine.stockQuantity) || medicine.stockQuantity < 0) {
      throw new PharmacyInventoryError("Invalid medicine stock; review inventory");
    }
    if (medicine.stockQuantity < dispenseQuantity) {
      throw new Error(`Insufficient stock. Required: ${dispenseQuantity}, Available: ${medicine.stockQuantity}`);
    }
    const revisionFilter = stockRevisionFilter(medicine.stockRevision ?? 0);
    const restricted = await prepareRestrictedSupply(medicineId, locationId, dispenseQuantity, auditContext);

    const now = new Date();
    const batches = await MedicineBatch.find({
      medicineId,
      locationId,
      status: "active",
      expiryDate: { $gt: now },
      quantity: { $gt: 0 },
    }).sort({ expiryDate: 1, receivedAt: 1, _id: 1 }).session(session);

    if (batches.some(batch => batch.lotVersion === 1)) {
      const location = await Location.findById(locationId).select("organizationId").session(session);
      if (!location || !medicine.unitDefinition) throw new PharmacyInventoryError("Captured lot ownership or units need inventory review");
      for (const batch of batches) validateCapturedLot(batch, medicine.unitDefinition, String(location.organizationId));
    }

    if (batches.length === 0) {
      // Any batch history establishes structured stock, including depleted,
      // expired or incorrectly located records. Never bypass it via aggregate stock.
      if (await MedicineBatch.exists({ medicineId }).session(session)) {
        throw new PharmacyInventoryError("Insufficient eligible batch stock; review inventory", 400);
      }
      if (!medicine.expiryDate || !Number.isFinite(new Date(medicine.expiryDate).getTime())) {
        throw new PharmacyInventoryError("Cannot dispense medicine with unknown expiry; review inventory", 400);
      }
      if (new Date(medicine.expiryDate) <= now) {
        throw new PharmacyInventoryError(`Cannot dispense expired medicine ${medicine.name}`, 400);
      }
      if (!Number.isFinite(medicine.price) || medicine.price < 0) {
        throw new PharmacyInventoryError("Invalid medicine price; review inventory");
      }
    } else if (batches.some(batch => !Number.isSafeInteger(batch.quantity) ||
        !Number.isFinite(batch.sellingPrice) || batch.sellingPrice < 0)) {
      throw new PharmacyInventoryError("Invalid medicine batch quantity or price; review inventory");
    }

    // A medicine without batch records is an older aggregate-only record. Preserve that
    // existing storage mode, but never partially consume a structured batch inventory.
    const originalBatchQuantities = batches.map((batch) => ({
      batch,
      quantity: batch.quantity,
      status: batch.status,
    }));

    if (batches.length === 0) {
      const updated = await Medicine.findOneAndUpdate(
        { _id: medicineId, locationId, deletedAt: null, stockQuantity: medicine.stockQuantity, ...revisionFilter },
        { $inc: { stockQuantity: -dispenseQuantity, stockRevision: 1 },
          $set: { stockLedgerStartedAt: medicine.stockLedgerStartedAt || new Date() } },
        { returnDocument: "after", ...queryOptions }
      );
      if (!updated) {
        throw new Error(`Insufficient stock or concurrent modification for medicine ${medicine.name}`);
      }
      await recordRestrictedSupply(restricted, [{ batchNumber: medicine.batchNumber || "", expiryDate: medicine.expiryDate || undefined, quantity: dispenseQuantity }]);
      await appendStockMovement(medicine, "dispense", medicine.stockQuantity - dispenseQuantity, [], session,
        { actorId: auditContext?.dispensedBy ? String(auditContext.dispensedBy) : undefined });
      const storedTax = await Medicine.findOne({ _id: medicine._id, locationId }).select("hsnCode gstRate").lean().session(session);
      await pinActivePharmacyLocation(locationId, session);
      return { dispensedBatches: [], totalCost: dispenseQuantity * medicine.price, pricedAllocations: [{
        batchNumber: medicine.batchNumber || "", expiryDate: medicine.expiryDate!, quantity: dispenseQuantity,
        unitPrice: medicine.price, hsnCode: storedTax?.hsnCode || "", gstRate: storedTax?.gstRate,
      }] };
    }

    const structuredQuantity = batches.reduce((total, batch) => total + batch.quantity, 0);
    if (structuredQuantity < dispenseQuantity) {
      throw new Error(`Insufficient batch stock. Required: ${dispenseQuantity}, Available: ${structuredQuantity}`);
    }

    let remainingToDispense = dispenseQuantity;
    const dispensedBatches: Array<{ batchId: string; batchNumber: string; quantity: number }> = [];
    let totalCost = 0;
    // Read before saving hydrated batches, since save may persist schema defaults.
    const storedTaxRows = await MedicineBatch.find({ _id: { $in: batches.map(batch => batch._id) }, medicineId, locationId })
      .select("hsnCode gstRate").lean().session(session);

    for (const batch of batches) {
      if (remainingToDispense <= 0) break;

      const qtyFromThisBatch = Math.min(batch.quantity, remainingToDispense);
      batch.quantity -= qtyFromThisBatch;
      if (batch.quantity === 0) batch.status = "depleted";
      await batch.save(queryOptions);

      remainingToDispense -= qtyFromThisBatch;
      dispensedBatches.push({
        batchId: batch._id.toString(),
        batchNumber: batch.batchNumber,
        quantity: qtyFromThisBatch,
      });
      totalCost += qtyFromThisBatch * batch.sellingPrice;
    }

    if (remainingToDispense !== 0) {
      throw new Error("Unable to allocate the requested quantity from medicine batches");
    }

    const updated = await Medicine.findOneAndUpdate(
      { _id: medicineId, locationId, deletedAt: null, stockQuantity: medicine.stockQuantity, ...revisionFilter },
      { $inc: { stockQuantity: -dispenseQuantity, stockRevision: 1 },
        $set: { stockLedgerStartedAt: medicine.stockLedgerStartedAt || new Date() } },
      { returnDocument: "after", ...queryOptions }
    );
    if (!updated) {
      throw new Error(`Insufficient stock or concurrent modification for medicine ${medicine.name}`);
    }

    await recordRestrictedSupply(restricted, dispensedBatches.map(lot => ({ ...lot, expiryDate: batches.find(batch => String(batch._id) === lot.batchId)!.expiryDate })));

    await appendStockMovement(medicine, "dispense", medicine.stockQuantity - dispenseQuantity,
      originalBatchQuantities.filter(original => original.quantity !== original.batch.quantity).map(original => ({
        batchId: original.batch._id, beforeQuantity: original.quantity, afterQuantity: original.batch.quantity,
        quantityDelta: original.batch.quantity - original.quantity,
      })), session, { actorId: auditContext?.dispensedBy ? String(auditContext.dispensedBy) : undefined });
    // Lean reads preserve missing legacy tax fields; hydrated schema defaults must not become tax evidence.
    await pinActivePharmacyLocation(locationId, session);
    return { dispensedBatches, totalCost, pricedAllocations: dispensedBatches.map(allocation => {
      const batch = batches.find(batch => String(batch._id) === allocation.batchId)!;
      const storedTax = storedTaxRows.find(row => String(row._id) === allocation.batchId);
      return { ...allocation, expiryDate: batch.expiryDate, unitPrice: batch.sellingPrice, hsnCode: storedTax?.hsnCode || "", gstRate: storedTax?.gstRate };
    }) };
  };

  return existingSession ? execute(existingSession) : withTransaction(execute);
}

/**
 * Get expiring medicine batches within N days.
 */
export async function getExpiringBatches(locationId: string, daysThreshold: number = 30, includePurchaseCost = true): Promise<any[]> {
  const targetDate = new Date(Date.now() + daysThreshold * 86400000);

  const rows = await MedicineBatch.find({
    locationId,
    status: { $in: ["active", "expired"] },
    quantity: { $gt: 0 },
    expiryDate: { $lte: targetDate },
  })
    .select(`organizationId locationId medicineId batchNumber expiryDate quantity sellingPrice mrp status lotVersion unitSnapshot expirySnapshot receivedAt receivedQuantity sellingPricePaise mrpPaise${includePurchaseCost ? " purchaseCost costBasis" : ""}`)
    .populate({ path: "medicineId", select: "name genericName reorderLevel hsnCode", match: { locationId } })
    .sort({ expiryDate: 1, _id: 1 }).limit(101).maxTimeMS(5000);
  if (rows.length > 100) throw new PharmacyInventoryError("This quick expiry list exceeds 100 lots. Use the paginated stock alerts or expiry report.", 409);
  return rows;
}

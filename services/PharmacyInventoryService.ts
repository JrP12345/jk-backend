import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";

export interface BatchAddInput {
  medicineId: string;
  clinicId: string;
  batchNumber: string;
  expiryDate: string | Date;
  quantity: number;
  purchaseCost: number;
  sellingPrice: number;
  mrp?: number;
  hsnCode?: string;
  gstRate?: number;
}

export async function addBatchToMedicine(input: BatchAddInput): Promise<any> {
  const medicine = await Medicine.findById(input.medicineId);
  if (!medicine) {
    throw new Error("Medicine record not found");
  }

  const expDate = new Date(input.expiryDate);
  if (isNaN(expDate.getTime())) {
    throw new Error("Invalid expiration date");
  }

  const batch = await MedicineBatch.create({
    medicineId: input.medicineId,
    clinicId: input.clinicId,
    batchNumber: input.batchNumber.trim(),
    expiryDate: expDate,
    quantity: input.quantity,
    purchaseCost: input.purchaseCost,
    sellingPrice: input.sellingPrice,
    mrp: input.mrp,
    hsnCode: input.hsnCode || medicine.get("hsnCode") || "3004",
    gstRate: input.gstRate !== undefined ? input.gstRate : (medicine.get("gstRate") || 5),
    status: expDate < new Date() ? "expired" : "active",
  });

  // Increment aggregate stock quantity on primary medicine document
  medicine.stockQuantity = (medicine.stockQuantity || 0) + input.quantity;
  await medicine.save();

  return batch;
}

/**
 * Dispense medicine using FEFO (First-Expired, First-Out) strategy.
 * Automatically selects nearest-expiring non-expired active batch.
 */
export async function dispenseMedicineFEFO(
  medicineId: string,
  clinicId: string,
  dispenseQuantity: number
): Promise<{ dispensedBatches: Array<{ batchId: string; batchNumber: string; quantity: number }>; totalCost: number }> {
  const medicine = await Medicine.findById(medicineId);
  if (!medicine) {
    throw new Error("Medicine record not found");
  }

  if (medicine.stockQuantity < dispenseQuantity) {
    throw new Error(`Insufficient stock. Required: ${dispenseQuantity}, Available: ${medicine.stockQuantity}`);
  }

  const now = new Date();

  // Fetch active batches sorted by earliest expiration date (FEFO)
  const batches = await MedicineBatch.find({
    medicineId,
    clinicId,
    status: "active",
    expiryDate: { $gt: now },
    quantity: { $gt: 0 },
  }).sort({ expiryDate: 1 });

  let remainingToDispense = dispenseQuantity;
  const dispensedBatches: Array<{ batchId: string; batchNumber: string; quantity: number }> = [];
  let totalCost = 0;

  for (const batch of batches) {
    if (remainingToDispense <= 0) break;

    const qtyFromThisBatch = Math.min(batch.quantity, remainingToDispense);
    batch.quantity -= qtyFromThisBatch;

    if (batch.quantity === 0) {
      batch.status = "depleted";
    }

    await batch.save();

    remainingToDispense -= qtyFromThisBatch;
    dispensedBatches.push({
      batchId: batch._id.toString(),
      batchNumber: batch.batchNumber,
      quantity: qtyFromThisBatch,
    });

    totalCost += qtyFromThisBatch * batch.sellingPrice;
  }

  // Fallback: If no structured batches existed, just decrement primary Medicine stock
  medicine.stockQuantity = Math.max(0, medicine.stockQuantity - dispenseQuantity);
  await medicine.save();

  return { dispensedBatches, totalCost };
}

/**
 * Get expiring medicine batches within N days.
 */
export async function getExpiringBatches(clinicId: string, daysThreshold: number = 30): Promise<any[]> {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + daysThreshold);

  return await MedicineBatch.find({
    clinicId,
    status: "active",
    expiryDate: { $lte: targetDate },
  })
    .populate("medicineId", "name genericName reorderLevel hsnCode")
    .sort({ expiryDate: 1 });
}

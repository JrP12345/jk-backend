import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { ScheduleH1Register } from "../models/ScheduleH1Register.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";

export interface DispenseAuditContext {
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
  const expDate = new Date(input.expiryDate);
  if (isNaN(expDate.getTime())) {
    throw new Error("Invalid expiration date");
  }

  const batchNumber = input.batchNumber.trim();
  if (!batchNumber) throw new Error("Batch number is required");
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Quantity must be a positive integer");
  if (!Number.isFinite(input.purchaseCost) || input.purchaseCost < 0 || !Number.isFinite(input.sellingPrice) || input.sellingPrice < 0) {
    throw new Error("Batch prices must be non-negative numbers");
  }
  return withTransaction(async (session) => {
    const queryOptions = session ? { session } : undefined;
    const medicine = await Medicine.findById(input.medicineId, null, queryOptions);
    if (!medicine) {
      throw new Error("Medicine record not found");
    }
    if (medicine.clinicId.toString() !== input.clinicId) {
      throw new Error("Medicine is not assigned to the selected clinic");
    }

    const duplicateBatch = await MedicineBatch.findOne(
      { medicineId: input.medicineId, clinicId: input.clinicId, batchNumber },
      null,
      queryOptions
    );
    if (duplicateBatch) throw new Error("A batch with this number already exists for the medicine");

    const batch = await createWithSession(
      MedicineBatch,
      {
        medicineId: input.medicineId,
        clinicId: input.clinicId,
        batchNumber,
        expiryDate: expDate,
        quantity: input.quantity,
        purchaseCost: input.purchaseCost,
        sellingPrice: input.sellingPrice,
        mrp: input.mrp,
        hsnCode: input.hsnCode || medicine.get("hsnCode") || "3004",
        gstRate: input.gstRate !== undefined ? input.gstRate : (medicine.get("gstRate") || 5),
        status: expDate < new Date() ? "expired" : "active",
      },
      session
    );

    await Medicine.findOneAndUpdate(
      { _id: input.medicineId, clinicId: input.clinicId },
      { $inc: { stockQuantity: input.quantity } },
      { returnDocument: "after", ...queryOptions }
    );

    return batch;
  });
}

/**
 * Dispense medicine using FEFO (First-Expired, First-Out) strategy.
 * Automatically selects nearest-expiring non-expired active batch.
 */
export async function dispenseMedicineFEFO(
  medicineId: string,
  clinicId: string,
  dispenseQuantity: number,
  existingSession?: mongoose.ClientSession | null,
  auditContext?: DispenseAuditContext
): Promise<{ dispensedBatches: Array<{ batchId: string; batchNumber: string; quantity: number }>; totalCost: number }> {
  if (!Number.isInteger(dispenseQuantity) || dispenseQuantity <= 0) {
    throw new Error("Dispense quantity must be a positive integer");
  }

  const execute = async (session: mongoose.ClientSession | null) => {
    const queryOptions = session ? { session } : undefined;
    const medicine = await Medicine.findById(medicineId, null, queryOptions);
    if (!medicine) {
      throw new Error("Medicine record not found");
    }
    if (medicine.clinicId.toString() !== clinicId) {
      throw new Error("Medicine is not assigned to the selected clinic");
    }
    if (medicine.stockQuantity < dispenseQuantity) {
      throw new Error(`Insufficient stock. Required: ${dispenseQuantity}, Available: ${medicine.stockQuantity}`);
    }

    const now = new Date();
    const batches = await MedicineBatch.find({
      medicineId,
      clinicId,
      status: "active",
      expiryDate: { $gt: now },
      quantity: { $gt: 0 },
    }).sort({ expiryDate: 1 }).session(session);

    // A medicine without batch records is an older aggregate-only record. Preserve that
    // existing storage mode, but never partially consume a structured batch inventory.
    const originalStock = medicine.stockQuantity;
    const originalBatchQuantities = batches.map((batch) => ({
      batch,
      quantity: batch.quantity,
      status: batch.status,
    }));

    try {
      if (batches.length === 0) {
        if (medicine.expiryDate && new Date(medicine.expiryDate) <= now) {
          throw new Error(`Cannot dispense expired medicine ${medicine.name}`);
        }
        const updated = await Medicine.findOneAndUpdate(
          { _id: medicineId, clinicId, stockQuantity: { $gte: dispenseQuantity } },
          { $inc: { stockQuantity: -dispenseQuantity } },
          { returnDocument: "after", ...queryOptions }
        );
        if (!updated) {
          throw new Error(`Insufficient stock or concurrent modification for medicine ${medicine.name}`);
        }
        if (
          medicine.scheduleType &&
          ["schedule_h", "schedule_h1", "schedule_x", "narcotic"].includes(medicine.scheduleType)
        ) {
          const orgId = auditContext?.organizationId || (medicine as any).organizationId;
          await createWithSession(
            ScheduleH1Register,
            {
              organizationId: orgId,
              clinicId: medicine.clinicId,
              medicineId: medicine._id,
              medicineName: medicine.name,
              genericName: medicine.genericName,
              scheduleType: medicine.scheduleType,
              batchNumber: medicine.batchNumber || "UNTRACKED-BATCH",
              quantityDispensed: dispenseQuantity,
              patientId: auditContext?.patientId || new mongoose.Types.ObjectId("000000000000000000000000"),
              patientName: auditContext?.patientName || "Walk-In Patient",
              patientAddress: auditContext?.patientAddress || "Local Walk-In",
              patientPhone: auditContext?.patientPhone,
              doctorId: auditContext?.doctorId,
              doctorName: auditContext?.doctorName || "Prescribing Physician",
              doctorRegNumber: auditContext?.doctorRegNumber || "NMC-UNSPECIFIED",
              prescriptionId: auditContext?.prescriptionId,
              encounterId: auditContext?.encounterId,
              invoiceId: auditContext?.invoiceId,
              dispensedBy: auditContext?.dispensedBy,
              dispensedByName: auditContext?.dispensedByName || "Dispensing Pharmacist",
              dispensedAt: new Date(),
            },
            session
          );
        }
        return { dispensedBatches: [], totalCost: dispenseQuantity * medicine.price };
      }

      const structuredQuantity = batches.reduce((total, batch) => total + batch.quantity, 0);
      if (structuredQuantity < dispenseQuantity) {
        throw new Error(`Insufficient batch stock. Required: ${dispenseQuantity}, Available: ${structuredQuantity}`);
      }

      let remainingToDispense = dispenseQuantity;
      const dispensedBatches: Array<{ batchId: string; batchNumber: string; quantity: number }> = [];
      let totalCost = 0;

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
        { _id: medicineId, clinicId, stockQuantity: { $gte: dispenseQuantity } },
        { $inc: { stockQuantity: -dispenseQuantity } },
        { returnDocument: "after", ...queryOptions }
      );
      if (!updated) {
        throw new Error(`Insufficient stock or concurrent modification for medicine ${medicine.name}`);
      }

      if (
        medicine.scheduleType &&
        ["schedule_h", "schedule_h1", "schedule_x", "narcotic"].includes(medicine.scheduleType)
      ) {
        const orgId = auditContext?.organizationId || (medicine as any).organizationId;
        for (const b of dispensedBatches) {
          await createWithSession(
            ScheduleH1Register,
            {
              organizationId: orgId,
              clinicId: medicine.clinicId,
              medicineId: medicine._id,
              medicineName: medicine.name,
              genericName: medicine.genericName,
              scheduleType: medicine.scheduleType,
              batchNumber: b.batchNumber,
              quantityDispensed: b.quantity,
              patientId: auditContext?.patientId || new mongoose.Types.ObjectId("000000000000000000000000"),
              patientName: auditContext?.patientName || "Walk-In Patient",
              patientAddress: auditContext?.patientAddress || "Local Walk-In",
              patientPhone: auditContext?.patientPhone,
              doctorId: auditContext?.doctorId,
              doctorName: auditContext?.doctorName || "Prescribing Physician",
              doctorRegNumber: auditContext?.doctorRegNumber || "NMC-UNSPECIFIED",
              prescriptionId: auditContext?.prescriptionId,
              encounterId: auditContext?.encounterId,
              invoiceId: auditContext?.invoiceId,
              dispensedBy: auditContext?.dispensedBy,
              dispensedByName: auditContext?.dispensedByName || "Dispensing Pharmacist",
              dispensedAt: new Date(),
            },
            session
          );
        }
      }

      return { dispensedBatches, totalCost };
    } catch (error) {
      // The transaction helper protects replica-set deployments. Restore the
      // documents explicitly when a standalone development database is used.
      if (!session) {
        for (const original of originalBatchQuantities) {
          original.batch.quantity = original.quantity;
          original.batch.status = original.status;
          await original.batch.save();
        }
        await Medicine.findByIdAndUpdate(medicineId, { $set: { stockQuantity: originalStock } });
      }
      throw error;
    }
  };

  return existingSession !== undefined ? execute(existingSession) : withTransaction(execute);
}

/**
 * Get expiring medicine batches within N days.
 */
export async function getExpiringBatches(clinicId: string, daysThreshold: number = 30): Promise<any[]> {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + daysThreshold);

  return await MedicineBatch.find({
    clinicId,
    status: { $in: ["active", "expired"] },
    expiryDate: { $lte: targetDate },
  })
    .populate("medicineId", "name genericName reorderLevel hsnCode")
    .sort({ expiryDate: 1 });
}

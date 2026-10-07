import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { addBatchToMedicine, dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";

describe("Pharmacy batch inventory integrity", () => {
  it("adds stock atomically and dispenses structured batches in FEFO order", async () => {
    const locationId = new mongoose.Types.ObjectId();
    const medicine = await Medicine.create({
      locationId,
      name: "FEFO Test Medicine",
      genericName: "FEFO Test Generic",
      stockQuantity: 0,
      price: 10,
      costPrice: 5,
    });

    await addBatchToMedicine({
      medicineId: medicine._id.toString(),
      locationId: locationId.toString(),
      batchNumber: "EARLIEST",
      expiryDate: new Date(Date.now() + 2 * 86400000),
      quantity: 10,
      purchaseCost: 4,
      sellingPrice: 9,
    });
    await addBatchToMedicine({
      medicineId: medicine._id.toString(),
      locationId: locationId.toString(),
      batchNumber: "LATER",
      expiryDate: new Date(Date.now() + 10 * 86400000),
      quantity: 10,
      purchaseCost: 5,
      sellingPrice: 11,
    });

    const result = await dispenseMedicineFEFO(medicine._id.toString(), locationId.toString(), 12);

    expect(result.dispensedBatches.map((batch) => batch.batchNumber)).toEqual(["EARLIEST", "LATER"]);
    expect(result.dispensedBatches.map((batch) => batch.quantity)).toEqual([10, 2]);
    expect(result.totalCost).toBe(112);
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(8);
    expect((await MedicineBatch.findOne({ medicineId: medicine._id, batchNumber: "EARLIEST" }))!.status).toBe("depleted");
    expect((await MedicineBatch.findOne({ medicineId: medicine._id, batchNumber: "LATER" }))!.quantity).toBe(8);
  });

  it("rejects a duplicate batch and leaves aggregate stock unchanged", async () => {
    const locationId = new mongoose.Types.ObjectId();
    const medicine = await Medicine.create({
      locationId,
      name: "Duplicate Batch Medicine",
      genericName: "Duplicate Batch Generic",
      stockQuantity: 0,
      price: 10,
      costPrice: 5,
    });
    const input = {
      medicineId: medicine._id.toString(),
      locationId: locationId.toString(),
      batchNumber: "DUPLICATE",
      expiryDate: new Date(Date.now() + 5 * 86400000),
      quantity: 4,
      purchaseCost: 4,
      sellingPrice: 8,
    };

    await addBatchToMedicine(input);
    await expect(addBatchToMedicine(input)).rejects.toThrow("already exists");
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(4);
    expect(await MedicineBatch.countDocuments({ medicineId: medicine._id, batchNumber: "DUPLICATE" })).toBe(1);
  });
});

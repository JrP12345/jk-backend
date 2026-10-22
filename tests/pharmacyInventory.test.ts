import { beforeAll, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { addBatchToMedicine, dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { StockMovement } from "../models/StockMovement.ts";

let inventoryLocationId: string;
beforeAll(async () => {
  const organization = await Organization.create({ name: "Inventory integrity", city: "Pune" });
  inventoryLocationId = (await Location.create({ organizationId: organization.id, name: "Inventory branch", city: "Pune" })).id;
  await StockMovement.init();
});

async function stock(quantity = 10) {
  return Medicine.create({ locationId: inventoryLocationId, name: "Eligibility medicine",
    genericName: "Eligibility generic", stockQuantity: quantity, price: 10, costPrice: 5,
    expiryDate: new Date("2099-12-31"), batchNumber: "LEGACY" });
}

async function batchFor(medicine: Awaited<ReturnType<typeof stock>>, overrides: Record<string, unknown> = {}) {
  return MedicineBatch.create({ medicineId: medicine._id, locationId: medicine.locationId,
    batchNumber: "STRUCTURED", expiryDate: new Date("2099-12-31"), quantity: 10,
    purchaseCost: 5, sellingPrice: 10, ...overrides });
}

describe("Pharmacy batch inventory integrity", () => {
  it("preserves dispensing of proven aggregate-only stock with known future expiry", async () => {
    const medicine = await stock();
    expect(await dispenseMedicineFEFO(medicine.id, String(medicine.locationId), 2)).toEqual({ dispensedBatches: [], totalCost: 20,
      pricedAllocations: [{ batchNumber: "LEGACY", expiryDate: new Date("2099-12-31"), quantity: 2, unitPrice: 10, hsnCode: "3004", gstRate: 5 }] });
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(8);
  });

  it.each([
    { status: "expired", expiryDate: new Date("2000-01-01") },
    { status: "active", expiryDate: new Date("2000-01-01") },
    { status: "depleted", quantity: 0 },
    { status: "depleted", quantity: 10 },
    { quantity: 0 },
    { locationId: new mongoose.Types.ObjectId() },
  ])("never falls back to aggregate stock for ineligible structured history: %j", async overrides => {
    const medicine = await stock();
    const batch = await batchFor(medicine, overrides);
    await expect(dispenseMedicineFEFO(medicine.id, String(medicine.locationId), 1)).rejects.toThrow(/eligible batch stock/i);
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(10);
    expect((await MedicineBatch.findById(batch._id))!.quantity).toBe(batch.quantity);
  });

  it("does not supplement insufficient eligible batches from an aggregate mismatch", async () => {
    const medicine = await stock();
    const batch = await batchFor(medicine, { quantity: 1 });
    await expect(dispenseMedicineFEFO(medicine.id, String(medicine.locationId), 2)).rejects.toThrow(/Insufficient.*batch stock/);
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(10);
    expect((await MedicineBatch.findById(batch._id))!.quantity).toBe(1);
  });

  it.each([null, new Date("2000-01-01")])("rejects aggregate-only stock with missing or expired expiry: %s", async expiryDate => {
    const medicine = await stock();
    await Medicine.updateOne({ _id: medicine._id }, { $set: { expiryDate } });
    await expect(dispenseMedicineFEFO(medicine.id, String(medicine.locationId), 1)).rejects.toThrow(/expiry|expired/i);
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(10);
  });

  it("rejects receipt and dispense after soft deletion without changing stock", async () => {
    const medicine = await stock();
    await Medicine.updateOne({ _id: medicine._id }, { $set: { deletedAt: new Date() } });
    await expect(dispenseMedicineFEFO(medicine.id, String(medicine.locationId), 1)).rejects.toThrow(/not found/i);
    await expect(addBatchToMedicine({ medicineId: medicine.id, locationId: String(medicine.locationId),
      batchNumber: "DELETED", expiryDate: "2099-12-31", quantity: 1, purchaseCost: 5, sellingPrice: 10 })).rejects.toThrow(/not found/i);
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(10);
    expect(await MedicineBatch.countDocuments({ medicineId: medicine._id })).toBe(0);
  });

  it.each(["receipt", "dispense"])("rolls back %s if deletion commits before its aggregate write", async operation => {
    const medicine = await stock();
    const batch = await batchFor(medicine);
    const update = Medicine.findOneAndUpdate.bind(Medicine);
    let deleted = false;
    const mock = vi.spyOn(Medicine, "findOneAndUpdate").mockImplementation(((...args: any[]) => {
      const query = (update as any)(...args);
      const execute = query.exec.bind(query);
      query.exec = async () => {
        if (!deleted) {
          deleted = true;
          await Medicine.collection.updateOne({ _id: medicine._id }, { $set: { deletedAt: new Date() } });
        }
        return execute();
      };
      return query;
    }) as typeof Medicine.findOneAndUpdate);
    try {
      const result = operation === "dispense"
        ? dispenseMedicineFEFO(medicine.id, String(medicine.locationId), 1)
        : addBatchToMedicine({ medicineId: medicine.id, locationId: String(medicine.locationId),
          batchNumber: "CONCURRENT", expiryDate: "2099-12-31", quantity: 1, purchaseCost: 5, sellingPrice: 10 });
      await expect(result).rejects.toThrow(/not found/i);
      expect(deleted).toBe(true);
      const stored = (await Medicine.findById(medicine._id))!;
      expect(stored.deletedAt).toBeTruthy();
      expect(stored.stockQuantity).toBe(10);
      expect((await MedicineBatch.findById(batch._id))!.quantity).toBe(10);
      expect(await MedicineBatch.countDocuments({ medicineId: medicine._id })).toBe(1);
    } finally { mock.mockRestore(); }
  });

  it.each([0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid quantities before receiving or dispensing: %s", async quantity => {
    const medicine = await stock();
    await expect(dispenseMedicineFEFO(medicine.id, String(medicine.locationId), quantity)).rejects.toThrow(/integer/i);
    await expect(addBatchToMedicine({ medicineId: medicine.id, locationId: String(medicine.locationId),
      batchNumber: "INVALID", expiryDate: "2099-12-31", quantity, purchaseCost: 5, sellingPrice: 10 })).rejects.toThrow(/integer/i);
    expect(await MedicineBatch.countDocuments({ medicineId: medicine._id })).toBe(0);
  });

  it("rejects a receipt that would overflow aggregate stock", async () => {
    const medicine = await stock(Number.MAX_SAFE_INTEGER);
    await expect(addBatchToMedicine({ medicineId: medicine.id, locationId: String(medicine.locationId),
      batchNumber: "OVERFLOW", expiryDate: "2099-12-31", quantity: 1, purchaseCost: 5, sellingPrice: 10 })).rejects.toThrow(/safe integer/i);
    expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(Number.MAX_SAFE_INTEGER);
    expect(await MedicineBatch.countDocuments({ medicineId: medicine._id })).toBe(0);
  });

  it("rejects corrupt stored batch quantities and prices before allocation", async () => {
    for (const overrides of [{ quantity: 1.5 }, { sellingPrice: -1 }, { sellingPrice: Infinity }]) {
      const medicine = await stock();
      const batch = await batchFor(medicine);
      await MedicineBatch.collection.updateOne({ _id: batch._id }, { $set: overrides });
      await expect(dispenseMedicineFEFO(medicine.id, String(medicine.locationId), 1)).rejects.toThrow(/invalid.*batch/i);
      expect((await Medicine.findById(medicine._id))!.stockQuantity).toBe(10);
    }
  });

  it("adds stock atomically and dispenses structured batches in FEFO order", async () => {
    const locationId = new mongoose.Types.ObjectId(inventoryLocationId);
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
    const locationId = new mongoose.Types.ObjectId(inventoryLocationId);
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

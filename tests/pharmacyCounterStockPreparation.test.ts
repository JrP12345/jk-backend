import mongoose from "mongoose";
import { beforeAll, expect, it } from "vitest";
import { app } from "../index.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { prepareCounterStock, dispenseMedicineFEFO, type CounterStockPreparation } from "../services/PharmacyInventoryService.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { createCapturedLotValidator } from "../utilities/pharmacyLot.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });

it("consumes prepared stock only once and preserves its movement and lot allocation", async () => {
  const fixture = await pharmacyRetailFixture();
  await withTransaction(async session => {
    const medicine = (await Medicine.findById(fixture.medicine.id).session(session))!;
    const stock = await prepareCounterStock(medicine, fixture, 2, session, true);
    const result = await dispenseMedicineFEFO(medicine.id, fixture.locationId, 2, session, { dispensedBy: fixture.user.id }, stock.preparation);
    expect(result.dispensedBatches).toEqual(stock.selected.map(({ batch, quantity }) => ({ batchId: batch.id, batchNumber: batch.batchNumber, quantity })));
    await expect(dispenseMedicineFEFO(medicine.id, fixture.locationId, 2, session, undefined, stock.preparation)).rejects.toThrow(/preparation changed/);
  });
  expect((await Medicine.findById(fixture.medicine.id))!.stockQuantity).toBe(8);
  expect((await MedicineBatch.findOne({ medicineId: fixture.medicine.id }))!.quantity).toBe(8);
  expect(await StockMovement.countDocuments({ medicineId: fixture.medicine.id, kind: "dispense" })).toBe(1);
});

it.each(["quantity", "location", "medicine", "forged"])("rejects a mismatched %s before any stock delta", async mismatch => {
  const fixture = await pharmacyRetailFixture();
  await withTransaction(async session => {
    const medicine = (await Medicine.findById(fixture.medicine.id).session(session))!;
    const stock = await prepareCounterStock(medicine, fixture, 1, session, true);
    await expect(dispenseMedicineFEFO(mismatch === "medicine" ? new mongoose.Types.ObjectId().toString() : medicine.id,
      mismatch === "location" ? new mongoose.Types.ObjectId().toString() : fixture.locationId,
      mismatch === "quantity" ? 2 : 1, session, undefined, mismatch === "forged" ? {} as CounterStockPreparation : stock.preparation)).rejects.toThrow(/preparation changed/);
  });
  expect((await Medicine.findById(fixture.medicine.id))!.stockQuantity).toBe(10);
});

it("rejects evidence from an earlier transaction on the same session", async () => {
  const fixture = await pharmacyRetailFixture(), session = await mongoose.startSession();
  let preparation: CounterStockPreparation | undefined;
  try {
    await session.withTransaction(async () => {
      const medicine = (await Medicine.findById(fixture.medicine.id).session(session))!;
      preparation = (await prepareCounterStock(medicine, fixture, 1, session, true)).preparation;
    });
    await session.withTransaction(async () => {
      await expect(dispenseMedicineFEFO(fixture.medicine.id, fixture.locationId, 1, session, undefined, preparation)).rejects.toThrow(/preparation changed/);
    });
  } finally { await session.endSession(); }
  expect((await Medicine.findById(fixture.medicine.id))!.stockQuantity).toBe(10);
});

it("rechecks eligibility at allocation if prepared lots expire before mutation", async () => {
  const fixture = await pharmacyRetailFixture();
  await withTransaction(async session => {
    const medicine = (await Medicine.findById(fixture.medicine.id).session(session))!;
    const stock = await prepareCounterStock(medicine, fixture, 1, session, true);
    stock.selected[0].batch.expiryDate = new Date(0);
    await expect(dispenseMedicineFEFO(medicine.id, fixture.locationId, 1, session, undefined, stock.preparation)).rejects.toThrow();
  });
  expect((await MedicineBatch.findOne({ medicineId: fixture.medicine.id }))!.quantity).toBe(10);
});

it("memoizes only expiry arithmetic while still rejecting each corrupted snapshot", async () => {
  const fixture = await pharmacyRetailFixture(), lot = (await MedicineBatch.findOne({ medicineId: fixture.medicine.id }).lean())!;
  const validate = createCapturedLotValidator();
  expect(() => validate(lot, lot.unitSnapshot, fixture.organizationId)).not.toThrow();
  const invalid = [
    { ...lot, expirySnapshot: { ...lot.expirySnapshot, cutoff: new Date(0) } },
    { ...lot, expirySnapshot: { ...lot.expirySnapshot, timezone: "UTC" } },
    { ...lot, expirySnapshot: { ...lot.expirySnapshot, value: "2099-11" } },
    { ...lot, quantity: -1 }, { ...lot, sellingPricePaise: 500 },
    { ...lot, costBasis: { ...lot.costBasis, totalPaise: 500 } },
    { ...lot, unitSnapshot: { ...lot.unitSnapshot, version: 2 } },
    { ...lot, organizationId: new mongoose.Types.ObjectId() },
  ];
  for (const corrupt of invalid) expect(() => validate(corrupt, lot.unitSnapshot, fixture.organizationId)).toThrow(/review/);
  expect(() => validate(lot, lot.unitSnapshot, fixture.organizationId)).not.toThrow();
});

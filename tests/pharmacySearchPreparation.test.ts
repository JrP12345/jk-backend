import mongoose from "mongoose";
import { expect, it, vi } from "vitest";
import { Medicine } from "../models/Medicine.ts";
import { inspectMedicineSearch, medicineSearchPreparationMode } from "../scripts/prepare-medicine-search.ts";
import { medicineSearchFilter } from "../utilities/pharmacySearch.ts";

it("keeps projection preparation disconnected/read-only unless explicit paused-write apply is selected", () => {
  expect(medicineSearchPreparationMode([]).mode).toBe("preview"); expect(medicineSearchPreparationMode(["--check"]).mode).toBe("check");
  expect(medicineSearchPreparationMode(["--apply", "--writes-paused", `--location=${"a".repeat(24)}`])).toMatchObject({ mode: "apply", locationId: "a".repeat(24) });
  for (const args of [["--apply"], ["--writes-paused"], ["--apply", "--check", "--writes-paused"], ["--check", "--location=bad"], ["--apply", "--writes-paused", "--location=" + "a".repeat(24), "--location=" + "b".repeat(24)]]) expect(() => medicineSearchPreparationMode(args)).toThrow();
});
it("detects missing current catalogue projections and repairs only derived fields in the chosen branch", async () => {
  const locationId = new mongoose.Types.ObjectId(), foreignId = new mongoose.Types.ObjectId();
  const [medicine, foreign] = await Medicine.create([{ locationId, name: "Example medicine", genericName: "Synthetic", price: 15, stockQuantity: 12 }, { locationId: foreignId, name: "Foreign medicine", genericName: "Other", price: 2 }]);
  await Medicine.collection.updateMany({}, { $unset: { searchIndex: "" } });
  expect(await inspectMedicineSearch(false, String(locationId))).toMatchObject({ scanned: 1, stale: 1, repaired: 0, ready: false });
  expect(await Medicine.findOne(medicineSearchFilter("example"))).toBeNull();
  expect(await inspectMedicineSearch(true, String(locationId))).toMatchObject({ scanned: 1, stale: 1, repaired: 1, ready: true });
  expect((await Medicine.findOne(medicineSearchFilter("example")))!.id).toBe(medicine.id);
  expect((await Medicine.findById(medicine.id))!).toMatchObject({ name: "Example medicine", price: 15, stockQuantity: 12 });
  expect(await Medicine.findById(foreign.id).select("+searchIndex").lean()).not.toHaveProperty("searchIndex");
  expect(await inspectMedicineSearch(false, String(locationId))).toMatchObject({ stale: 0, ready: true });
});
it("refuses to publish keys from a source identity changed after the preparation read", async () => {
  const locationId = new mongoose.Types.ObjectId(), medicine = await Medicine.create({ locationId, name: "Before", genericName: "Synthetic", price: 15 });
  await Medicine.collection.updateOne({ _id: medicine._id }, { $unset: { searchIndex: "" } });
  const update = Medicine.collection.updateOne.bind(Medicine.collection);
  const spy = vi.spyOn(Medicine.collection, "updateOne").mockImplementationOnce((async (filter: any, value: any) => { await update({ _id: medicine._id }, { $set: { name: "After" } }); return update(filter, value); }) as any);
  try { expect(await inspectMedicineSearch(true, String(locationId))).toMatchObject({ stale: 1, repaired: 0, conflicts: 1, ready: false }); } finally { spy.mockRestore(); }
  expect(await Medicine.findById(medicine.id).select("+searchIndex").lean()).not.toHaveProperty("searchIndex");
});

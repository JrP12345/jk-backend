import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { medicineSearchFilter } from "../utilities/pharmacySearch.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof pharmacyRetailFixture>>;
const lookup = (f: Fixture, kind: string, search: string, cursor?: string) => app.inject({ method: "GET", url: `/api/pharmacy/sales/${kind}?${new URLSearchParams({ locationId: f.locationId, search, ...(cursor ? { cursor } : {}) })}`, headers: f.headers });

it("matches literal medicine terms across fields without changing sale eligibility or exposing cost", async () => {
  const f = await pharmacyRetailFixture();
  const target = await Medicine.create({ locationId: f.locationId, name: "Example Plus (A+B)", genericName: "Paracetamol", strength: "500 mg", manufacturer: "Acme Pharma", stockQuantity: 0, price: 10, costPrice: 1, scheduleType: "schedule_h" });
  for (const search of ["acme 500 para", "pharma 500", "(a+b)", " PARA   500 "]) {
    const response = await lookup(f, "products", search);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items).toMatchObject([{ id: target.id, eligible: false }]);
    expect(response.body).not.toContain("costPrice");
    expect(response.headers["cache-control"]).toBe("no-store");
  }
  for (const search of ["a.*", "[", "para 650"]) expect((await lookup(f, "products", search)).json().data.items).toEqual([]);
  expect((await lookup(f, "products", "a b c d e f g h i")).statusCode).toBe(400);
  await Medicine.updateOne({ _id: target._id }, { $set: { name: "Renamed example", manufacturer: "Different supplier" } });
  expect((await lookup(f, "products", "acme")).json().data.items).toEqual([]);
  expect((await lookup(f, "products", "different renamed")).json().data.items[0].id).toBe(target.id);
  await Medicine.updateOne({ _id: target._id }, { $set: { deletedAt: new Date() } });
  expect((await lookup(f, "products", "different renamed")).json().data.items).toEqual([]);
});

it("finds customer names or formatted phone fragments, excluding archived, supplier-only, GST and foreign parties", async () => {
  const f = await pharmacyRetailFixture();
  const common = { organizationId: f.organizationId, locationIds: [f.locationId], name: "Actual customer", normalizedName: "actual customer", kinds: ["customer"] as Array<"customer" | "supplier">, address: "Actual address", phone: "+91 (09876) 543-210", gstRegistration: "unregistered" as const, createdBy: f.user.id, updatedBy: f.user.id };
  const target = await PharmacyParty.create(common);
  await PharmacyParty.create([{ ...common, archived: true }, { ...common, kinds: ["supplier"] as Array<"customer" | "supplier"> }, { ...common, locationIds: [new mongoose.Types.ObjectId()] }, { ...common, organizationId: new mongoose.Types.ObjectId() }, { ...common, gstin: "27ABCDE1234F1Z5", gstRegistration: "registered" as const }]);
  for (const search of [" ACTUAL   customer ", "09876543210", "+91 09876 543210", "543210"]) {
    const response = await lookup(f, "customers", search);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items.map((party: { id: string }) => party.id)).toEqual([target.id]);
  }
  expect((await lookup(f, "customers", ".*")).json().data.items).toEqual([]);
  const numericName = await PharmacyParty.create({ ...common, name: "001 clinic", normalizedName: "001 clinic", phone: "55555" });
  expect((await lookup(f, "customers", "001")).json().data.items.map((party: { id: string }) => party.id)).toEqual([numericName.id]);
  const foreign = await pharmacyRetailFixture();
  expect((await app.inject({ method: "GET", url: `/api/pharmacy/sales/customers?locationId=${f.locationId}&search=543210`, headers: foreign.headers })).statusCode).toBe(404);
});

it("bounds broad multi-field searches with a stable cursor and enforces branch authority", async () => {
  const f = await pharmacyRetailFixture();
  await Medicine.insertMany(Array.from({ length: 28 }, (_, index) => ({ locationId: f.locationId, name: `Tablet ${index}`, genericName: "Generic", manufacturer: "Paging maker", strength: "10 mg", price: 1 })));
  const page = (await lookup(f, "products", "maker 10")).json().data;
  expect(page.items).toHaveLength(25);
  const last = (await lookup(f, "products", "maker 10", page.nextCursor)).json().data;
  expect(last.items).toHaveLength(3); expect(last.nextCursor).toBeNull();
  expect(new Set([...page.items, ...last.items].map(row => row.id)).size).toBe(28);
  const foreign = await pharmacyRetailFixture();
  expect((await app.inject({ method: "GET", url: `/api/pharmacy/sales/products?locationId=${f.locationId}&search=maker`, headers: foreign.headers })).statusCode).toBe(404);
});

it("presents read failures as search errors rather than an uncertain financial command", async () => {
  const f = await pharmacyRetailFixture(), find = vi.spyOn(Medicine, "find").mockImplementationOnce(() => { throw Error("Simulated read failure"); });
  try {
    const response = await lookup(f, "products", "product");
    expect(response.statusCode).toBe(503);
    expect(response.json().message).toContain("Medicine search is unavailable");
    expect(response.body).not.toContain("same reference");
  } finally { find.mockRestore(); }
});

it("finds a selective literal term through normalized indexes in a 10,000-product branch", async () => {
  const f = await pharmacyRetailFixture();
  const name = (index: number) => `Catalogue ${String(index).replace(/\d/g, digit => "abcdefghij"[Number(digit)])}`;
  await Medicine.insertMany(Array.from({ length: 10_000 }, (_, index) => ({ locationId: f.locationId, name: name(index), genericName: "Synthetic formulation", manufacturer: "Benchmark maker", strength: index === 9999 ? "650 mg" : "500 mg", stockQuantity: 0, price: 1 })));
  const foreign = await pharmacyRetailFixture();
  await Medicine.insertMany(Array.from({ length: 1000 }, () => ({ locationId: foreign.locationId, name: "Foreign catalogue", genericName: "Synthetic formulation", manufacturer: "Benchmark maker", strength: "650 mg", stockQuantity: 0, price: 1 })));
  const search = "maker 650", started = performance.now(), response = await lookup(f, "products", search);
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data.items).toMatchObject([{ name: name(9999) }]);
  const elapsedMs = Math.round(performance.now() - started);
  const explain = await Medicine.collection.find({ locationId: new mongoose.Types.ObjectId(f.locationId), deletedAt: null, ...medicineSearchFilter(search) })
    .project({ name: 1, genericName: 1, strength: 1, manufacturer: 1, barcodes: 1, unitDefinition: 1, stockQuantity: 1, price: 1, scheduleType: 1, dispensingRevision: 1, dispensingReview: 1 })
    .sort({ _id: 1 }).limit(26).maxTimeMS(3000).explain("executionStats");
  expect(JSON.stringify(explain.queryPlanner.winningPlan)).toContain("pharmacy_search_");
  expect(explain.executionStats?.totalDocsExamined).toBeLessThanOrEqual(5);
  const report = { products: 10_000, foreignProducts: 1000, elapsedMs, returned: response.json().data.items.length, docsExamined: explain.executionStats?.totalDocsExamined, keysExamined: explain.executionStats?.totalKeysExamined };
  await mkdir(".cache/pharmacy-search", { recursive: true }); await writeFile(".cache/pharmacy-search/benchmark.json", JSON.stringify(report, null, 2));
}, 120_000);

it("keeps literal Unicode, short terms and metadata edits searchable without exposing derived keys", async () => {
  const f = await pharmacyRetailFixture();
  const medicine = await Medicine.create({ locationId: f.locationId, name: "Ｆｏｌｉｃ Plus", genericName: "Vitamin B9", manufacturer: "Old maker", price: 1 });
  for (const search of ["folic", "b9", "9", "olic"]) expect((await lookup(f, "products", search)).json().data.items[0].id).toBe(medicine.id);
  expect(medicine.toJSON()).not.toHaveProperty("searchIndex");
  expect(await Medicine.findById(medicine.id).lean()).not.toHaveProperty("searchIndex");
  await Promise.all([
    Medicine.updateOne({ _id: medicine._id }, { $set: { name: "New identity" } }),
    Medicine.updateOne({ _id: medicine._id }, { $set: { manufacturer: "Second maker" } }),
  ]);
  expect((await lookup(f, "products", "new second")).json().data.items[0].id).toBe(medicine.id);
  expect((await lookup(f, "products", "old")).json().data.items).toEqual([]);
  await Medicine.findOneAndUpdate({ _id: medicine._id }, { $unset: { manufacturer: 1 } });
  expect((await lookup(f, "products", "second")).json().data.items).toEqual([]);
  const saved = (await Medicine.findById(medicine.id))!; saved.genericName = "Updated folate"; await saved.save();
  expect((await lookup(f, "products", "updated new")).json().data.items[0].id).toBe(medicine.id);
  await Medicine.bulkWrite([{ updateOne: { filter: { _id: medicine._id }, update: { $set: { strength: "42 mcg" } } } }]);
  expect((await lookup(f, "products", "42 new")).json().data.items[0].id).toBe(medicine.id);
  await Medicine.replaceOne({ _id: medicine._id }, { locationId: f.locationId, name: "Replacement", genericName: "Zinc", price: 2 });
  expect((await lookup(f, "products", "zinc")).json().data.items[0].id).toBe(medicine.id);
  expect((await lookup(f, "products", "folate")).json().data.items).toEqual([]);
  await expect(Medicine.updateOne({ _id: medicine._id }, { $set: { "searchIndex.name": { value: "spoofed", grams: ["spo"] } } })).rejects.toThrow("derived");
});

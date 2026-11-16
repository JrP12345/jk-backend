import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyPurchaseFixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
import { PharmacyShortbook } from "../models/PharmacyShortbook.ts";
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof pharmacyPurchaseFixture>>;
const save = (f: Fixture, fields: Record<string, unknown> = {}, medicineId = f.medicine.id) => app.inject({ method: "PUT", url: `/api/pharmacy/shortbook/${medicineId}`, headers: f.headers, payload: { locationId: f.locationId, quantity: 21, expectedUnitVersion: 1, expectedRevision: 0, note: "Requested replenishment", status: "open", ...fields } });
const read = (f: Fixture, extra = "") => app.inject({ method: "GET", url: `/api/pharmacy/shortbook?locationId=${f.locationId}${extra}`, headers: f.headers });

it("stores one revisioned shortage per branch product without changing inventory or financial sources", async () => {
  const f = await pharmacyPurchaseFixture(), before = { lots: await MedicineBatch.countDocuments(), movements: await StockMovement.countDocuments(), invoices: await Invoice.countDocuments() };
  const result = await save(f); expect(result.statusCode, result.body).toBe(200); expect(result.json().data.revision).toBe(1);
  const page = await read(f); expect(page.statusCode, page.body).toBe(200); expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.json().data.items).toMatchObject([{ medicineId: f.medicine.id, quantity: 21, unitVersion: 1, revision: 1, product: { name: f.medicine.name, unitDefinition: { unitsPerPack: 10 } } }]);
  expect(page.body).not.toMatch(/costPrice|purchaseCost|updatedBy/);
  expect((await save(f, { expectedRevision: 1, status: "resolved" })).statusCode).toBe(200);
  expect((await read(f)).json().data.items).toEqual([]);
  expect((await read(f, "&status=resolved")).json().data.items[0].revision).toBe(2);
  expect((await save(f, { expectedRevision: 2, quantity: 30 })).statusCode).toBe(200);
  expect(await PharmacyShortbook.countDocuments({ locationId: f.locationId })).toBe(1);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
  expect({ lots: await MedicineBatch.countDocuments(), movements: await StockMovement.countDocuments(), invoices: await Invoice.countDocuments() }).toEqual(before);
  expect(await AuditLog.countDocuments({ action: "PHARMACY_SHORTBOOK_UPDATED" })).toBe(3);
});
it("rejects stale and concurrent edits instead of losing another operator's shortage", async () => {
  const f = await pharmacyPurchaseFixture();
  const results = await Promise.all([save(f), save(f, { quantity: 30 })]);
  expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
  const entry = (await read(f)).json().data.items[0];
  expect((await save(f, { expectedRevision: 1, quantity: 12 })).statusCode).toBe(200);
  expect((await save(f, { expectedRevision: entry.revision, quantity: 25 })).statusCode).toBe(409);
  expect((await read(f)).json().data.items[0].quantity).toBe(12);
});
it("paginates bounded branch entries without duplicates", async () => {
  const f = await pharmacyPurchaseFixture();
  const products = await Medicine.insertMany(Array.from({ length: 28 }, (_, n) => ({ locationId: f.locationId, name: `Shortbook page ${n}`, genericName: "Synthetic", price: 1, unitDefinition: { version: 1, baseUnit: "piece", packUnit: "box", unitsPerPack: 10 } })));
  await PharmacyShortbook.insertMany(products.map(product => ({ organizationId: f.organizationId, locationId: f.locationId, medicineId: product._id, quantity: 1, unitVersion: 1, status: "open", revision: 1, updatedBy: f.user.id })));
  const first = (await read(f)).json().data; expect(first.items).toHaveLength(25); expect(first.nextCursor).toBeTruthy();
  const last = (await read(f, `&cursor=${first.nextCursor}`)).json().data; expect(last.items).toHaveLength(3); expect(last.nextCursor).toBeNull();
  expect(new Set([...first.items, ...last.items].map(row => row.id)).size).toBe(28);
});
it("requires fresh unit review and can close an original shortage after product archival", async () => {
  const f = await pharmacyPurchaseFixture(); expect((await save(f)).statusCode).toBe(200);
  await Medicine.updateOne({ _id: f.medicine._id }, { $set: { "unitDefinition.version": 2 } });
  expect((await save(f, { expectedRevision: 1 })).statusCode).toBe(409);
  expect((await save(f, { expectedRevision: 1, expectedUnitVersion: 2, quantity: 5 })).statusCode).toBe(200);
  await Medicine.updateOne({ _id: f.medicine._id }, { $set: { deletedAt: new Date() } });
  expect((await read(f)).json().data.items[0].product).toBeNull();
  expect((await save(f, { expectedRevision: 2, expectedUnitVersion: 2, quantity: 5, status: "resolved" })).statusCode).toBe(200);
  expect((await save(f, { expectedRevision: 3, expectedUnitVersion: 2, quantity: 5 })).statusCode).toBe(404);
});
it.each([{ quantity: 0 }, { quantity: 1.5 }, { quantity: "3" }, { quantity: 1_000_001 }, { status: "received" }, { note: "A\nB" }, { expectedUnitVersion: 0 }, { expectedRevision: -1 }, { stockQuantity: 50 }])("rejects unsupported shortbook input %j", async fields => {
  const f = await pharmacyPurchaseFixture(); expect((await save(f, fields)).statusCode).toBe(400); expect(await PharmacyShortbook.countDocuments({ locationId: f.locationId })).toBe(0);
});
it("scopes product IDs, branch visibility and purchase authority, including late revocation", async () => {
  const f = await pharmacyPurchaseFixture(), foreign = await pharmacyPurchaseFixture();
  expect((await save(f, {}, foreign.medicine.id)).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: `/api/pharmacy/shortbook?locationId=${foreign.locationId}`, headers: f.headers })).statusCode).toBe(404);
  await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: [] } });
  expect((await read(f)).statusCode).toBe(403); expect((await save(f)).statusCode).toBe(403);
});
it("rolls back the shortlist write if required audit evidence fails", async () => {
  const f = await pharmacyPurchaseFixture(), create = AuditLog.create.bind(AuditLog);
  const spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_SHORTBOOK_UPDATED") throw Error("Synthetic audit failure"); return (create as any)(docs, ...args); }) as any);
  try { expect((await save(f)).statusCode).toBe(503); } finally { spy.mockRestore(); }
  expect(await PharmacyShortbook.countDocuments({ locationId: f.locationId })).toBe(0);
});

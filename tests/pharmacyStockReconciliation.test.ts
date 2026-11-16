import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { Location } from "../models/Location.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { createAuthSession } from "../utilities/helpers.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
const key = () => crypto.randomUUID();
type Fixture = Awaited<ReturnType<typeof pharmacyRetailFixture>>;
const path = (f: Fixture, suffix = "") => `/api/pharmacy/locations/${f.locationId}/stock-reconciliation${suffix}`;
const get = (f: Fixture) => app.inject({ method: "GET", url: path(f), headers: f.headers });
const post = (f: Fixture, suffix: string, payload: object, reference?: string) => app.inject({ method: "POST", url: path(f, suffix), headers: { ...f.headers, ...(reference ? { "idempotency-key": reference } : {}) }, payload });
async function fixture() {
  const f = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "MANAGE_MEDICINES", "PHARMACY_SELL"]);
  await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: false, inventoryMode: "billing_only", revision: 1 } } });
  return f;
}
async function count(f: Fixture) {
  const read = await get(f); expect(read.statusCode, read.body).toBe(200);
  const snapshot = read.json().data;
  return { snapshot, value: { snapshotHash: snapshot.snapshotHash, reference: "Synthetic complete physical count", counts: snapshot.products.map((p: any) => ({ medicineId: p.id, lots: p.lots.map((lot: any) => ({ batchId: lot.id, quantity: lot.quantity })), newLots: [] as any[] })) } };
}
async function preview(f: Fixture, value: object) {
  const result = await post(f, "/preview", value); expect(result.statusCode, result.body).toBe(200);
  return { ...value, previewHash: result.json().data.previewHash, confirmed: true };
}

it("requires a paused billing-only branch, full stock/cost authority and owned location access", async () => {
  const f = await fixture();
  await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": true } });
  expect((await get(f)).statusCode).toBe(409);
  await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": false, "pharmacyCapability.inventoryMode": "tracked" } });
  expect((await get(f)).statusCode).toBe(409);
  const settingsOnly = await pharmacyRetailFixture(["PHARMACY_MANAGE_SETTINGS"]);
  expect((await get(settingsOnly)).statusCode).toBe(403);
  const foreign = await fixture();
  const denied = await app.inject({ method: "GET", url: path(foreign), headers: f.headers });
  expect([403, 404]).toContain(denied.statusCode);
});

it("previews without writes and atomically adjusts existing lots, adds actual counted lots, enables tracking and replays", async () => {
  const f = await fixture();
  const product = await Medicine.create({ locationId: f.locationId, name: "New counted product", genericName: "Synthetic", price: 15, stockQuantity: 0, unitDefinition: { version: 1, baseUnit: "piece", packUnit: "box", unitsPerPack: 10 } });
  const { value } = await count(f);
  value.counts.find((row: any) => row.medicineId === f.medicine.id).lots[0].quantity = 4;
  value.counts.find((row: any) => row.medicineId === product.id).newLots = [
    { medicineId: product.id, locationId: f.locationId, receiptLineId: key(), kind: "receipt", expectedUnitVersion: 1, packs: 0, looseUnits: 5, batchNumber: "COUNTED-PRINTED", expiry: { precision: "month", value: "2099-12" }, purchaseTotalPaise: 101, sellingPricePaise: 1500, mrpPaise: 2000 },
    { medicineId: product.id, locationId: f.locationId, receiptLineId: key(), kind: "receipt", expectedUnitVersion: 1, packs: 0, looseUnits: 2, batchNumber: "EXPIRED-COUNT", expiry: { precision: "month", value: "2020-12" }, purchaseTotalPaise: 200, sellingPricePaise: 1500, mrpPaise: 2000 },
  ];
  const before = await StockMovement.countDocuments({ locationId: f.locationId });
  const prepared = await preview(f, value);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect(await MedicineBatch.countDocuments({ medicineId: product.id })).toBe(0);
  const reference = key(), committed = await post(f, "/commit", prepared, reference);
  expect(committed.statusCode, committed.body).toBe(200);
  expect(committed.json().data).toMatchObject({ requestKey: reference, inventoryMode: "tracked", products: 2, changedProducts: 2, beforeUnits: 10, countedUnits: 11, newLots: 2, revision: 2 });
  expect((await Location.findById(f.locationId))!.pharmacyCapability).toMatchObject({ enabled: true, inventoryMode: "tracked", revision: 2 });
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
  expect((await Medicine.findById(product.id))!.stockQuantity).toBe(7);
  expect((await MedicineBatch.findOne({ medicineId: product.id, batchNumber: "EXPIRED-COUNT" }))!.status).toBe("expired");
  expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(before + 3); // two adjustments and new product baseline
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  const replay = await post(f, "/commit", prepared, reference);
  expect(replay.statusCode, replay.body).toBe(200); expect(replay.json().data.replayed).toBe(true);
  expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(before + 3);
  const recovery = await app.inject({ method: "GET", url: path(f, `/operations/${reference}`), headers: f.headers });
  expect(recovery.statusCode).toBe(200); expect(recovery.json().data.requestKey).toBe(reference);
});

it("rejects missing, duplicate, negative, foreign and altered preview counts before writing", async () => {
  const f = await fixture(), { value } = await count(f);
  for (const counts of [[], [...value.counts, value.counts[0]], [{ ...value.counts[0], lots: [] }], [{ ...value.counts[0], lots: [{ ...value.counts[0].lots[0], quantity: -1 }] }], [{ ...value.counts[0], lots: [{ batchId: new mongoose.Types.ObjectId().toHexString(), quantity: 0 }] }]]) {
    expect((await post(f, "/preview", { ...value, counts })).statusCode).toBe(400);
  }
  const prepared = await preview(f, value);
  expect((await post(f, "/commit", { ...prepared, counts: [{ ...value.counts[0], lots: [{ ...value.counts[0].lots[0], quantity: 9 }] }] }, key())).statusCode).toBe(409);
  expect((await post(f, "/commit", { ...prepared, confirmed: false }, key())).statusCode).toBe(400);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await Location.findById(f.locationId))!.pharmacyCapability!.inventoryMode).toBe("billing_only");
});

it("invalidates a preview after catalogue, lot or branch changes and keeps the branch paused", async () => {
  const f = await fixture(), { value } = await count(f);
  const prepared = await preview(f, value);
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { price: 11 } });
  const result = await post(f, "/commit", prepared, key());
  expect(result.statusCode).toBe(409); expect(result.json().details?.code).toBe("COUNT_SNAPSHOT_CHANGED");
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await Location.findById(f.locationId))!.pharmacyCapability!.enabled).toBe(false);
});

it("rolls all adjustments and the branch transition back when the required reconciliation audit fails", async () => {
  const f = await fixture(), { value } = await count(f); value.counts[0].lots[0].quantity = 3;
  const prepared = await preview(f, value), before = await StockMovement.countDocuments({ locationId: f.locationId });
  const create = AuditLog.create.bind(AuditLog), spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => {
    if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_STOCK_RECONCILED") throw Error("Synthetic audit failure");
    return (create as any)(docs, ...args);
  }) as any);
  try { expect((await post(f, "/commit", prepared, key())).statusCode).toBe(500); } finally { spy.mockRestore(); }
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await MedicineBatch.findOne({ medicineId: f.medicine.id }))!.quantity).toBe(10);
  expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(before);
  expect((await Location.findById(f.locationId))!.pharmacyCapability).toMatchObject({ enabled: false, inventoryMode: "billing_only", revision: 1 });
});

it("commits concurrent same-key attempts once and keeps recovery actor-bound", async () => {
  const f = await fixture(), { value } = await count(f); value.counts[0].lots[0].quantity = 6;
  const prepared = await preview(f, value), reference = key();
  const responses = await Promise.all([post(f, "/commit", prepared, reference), post(f, "/commit", prepared, reference)]);
  for (const result of responses) expect(result.statusCode, result.body).toBe(200);
  expect(await StockMovement.countDocuments({ locationId: f.locationId, kind: "adjustment" })).toBe(1);
  const other = await User.create({ name: "Other manager", email: `${key()}@example.test`, role: f.role });
  await OrgMember.create({ organizationId: f.organizationId, userId: other.id, role: f.role, locationAccess: { mode: "selected", locationIds: [f.locationId] } });
  const session = await createAuthSession({ id: other.id, role: f.role, email: other.email!, organization_id: f.organizationId });
  const recovery = await app.inject({ method: "GET", url: path(f, `/operations/${reference}`), headers: { authorization: `Bearer ${session.accessToken}` } });
  expect(recovery.statusCode).toBe(404);
});

it("exposes phase timing to allowed browser origins without exposing response data", async () => {
  const result = await app.inject({ method: "OPTIONS", url: "/api/pharmacy/sales", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
  expect(result.headers["access-control-expose-headers"]).toContain("Server-Timing");
});

it("preserves an actual billing-only invoice and resumes tracked billing against the counted quantity", async () => {
  const f = await fixture();
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { billingSupply: { batchNumber: "SUPPLIED-LOT", expiry: { precision: "month", value: "2099-12" }, mrpPaise: 1200 } } });
  await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": true } });
  const supply = (mode: "tracked" | "billing_only") => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key() }, payload: {
    locationId: f.locationId, expectedInventoryMode: mode, confirmationMode: "current_total", expectedTotalPaise: 1000,
    lines: [{ medicineId: f.medicine.id, lineId: key(), expectedUnitVersion: 1, quantity: 1, discountPaise: 0, expectedLineTotalPaise: 1000 }],
  } });
  const untracked = await supply("billing_only"); expect(untracked.statusCode, untracked.body).toBe(201);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  const original = await Invoice.findById(untracked.json().data.invoiceId).lean();
  const pause = await app.inject({ method: "PATCH", url: `/api/pharmacy/locations/${f.locationId}/settings`, headers: f.headers, payload: { enabled: false, inventoryMode: "billing_only", expectedRevision: 1, reviewReference: "Physical shelf count" } });
  expect(pause.statusCode, pause.body).toBe(200);
  const { value } = await count(f); value.counts[0].lots[0].quantity = 9;
  const result = await post(f, "/commit", await preview(f, value), key()); expect(result.statusCode, result.body).toBe(200);
  expect(await Invoice.findById(untracked.json().data.invoiceId).lean()).toEqual(original);
  expect((await PharmacyDispense.findById(untracked.json().data.dispenseId))!.inventoryMode).toBe("billing_only");
  const tracked = await supply("tracked"); expect(tracked.statusCode, tracked.body).toBe(201);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  expect((await PharmacyDispense.findById(tracked.json().data.dispenseId))!.inventoryMode).toBe("tracked");
  const invoicePath = `/api/pharmacy/invoices/${untracked.json().data.invoiceId}`;
  const source = await app.inject({ method: "GET", url: `${invoicePath}/return-source?locationId=${f.locationId}`, headers: f.headers });
  expect(source.statusCode, source.body).toBe(200);
  const row = source.json().data.lines[0];
  const returnedQuote = await app.inject({ method: "POST", url: `${invoicePath}/returns/quote`, headers: f.headers, payload: { locationId: f.locationId, reason: "Goods physically returned", reviewReference: "Synthetic return approval", confirmedQuarantine: true, lines: [{ sourceLineId: row.sourceLineId, sourceBatchId: row.sourceBatchId, quantity: 1, condition: "unopened" }] } });
  expect(returnedQuote.statusCode, returnedQuote.body).toBe(200);
  const returned = await app.inject({ method: "POST", url: `${invoicePath}/returns`, headers: { ...f.headers, "idempotency-key": key() }, payload: returnedQuote.json().data.issueInput });
  expect(returned.statusCode, returned.body).toBe(201);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8); // Original untracked supply never restocks counted inventory.
});

it("rolls back a count if branch settings change while its stock writes are in flight", async () => {
  const f = await fixture(), { value } = await count(f); value.counts[0].lots[0].quantity = 4;
  const prepared = await preview(f, value);
  const update = Location.updateOne.bind(Location);
  const spy = vi.spyOn(Location, "updateOne").mockImplementation(((filter: any, ...args: any[]) => {
    if (filter["pharmacyCapability.inventoryMode"] === "billing_only") return (async () => {
      await Location.collection.updateOne({ _id: new mongoose.Types.ObjectId(f.locationId) }, { $inc: { "pharmacyCapability.revision": 1, __v: 1 } });
      return (update as any)(filter, ...args);
    })();
    return (update as any)(filter, ...args);
  }) as any);
  let result;
  try { result = await post(f, "/commit", prepared, key()); } finally { spy.mockRestore(); }
  expect(result.statusCode, result.body).toBe(409);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await MedicineBatch.findOne({ medicineId: f.medicine.id }))!.quantity).toBe(10);
  expect(await StockMovement.countDocuments({ locationId: f.locationId, kind: "adjustment" })).toBe(0);
  expect((await Location.findById(f.locationId))!.pharmacyCapability!.inventoryMode).toBe("billing_only");
});

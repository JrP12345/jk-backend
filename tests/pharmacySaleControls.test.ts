import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
const fixture = () => pharmacyRetailFixture(["MANAGE_ORGANIZATION", "PHARMACY_VIEW_STOCK", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const hold = (f: Fixture, id = f.medicine.id, kind = "medicines", blocked = true, expectedRevision = 0, extra = {}) => app.inject({ method: "PUT", url: `/api/pharmacy/${kind}/${id}/sale-control`, headers: f.headers,
  payload: { locationId: f.locationId, expectedRevision, blocked, reason: "Synthetic exact selection reviewed", reviewReference: "TEST ONLY reviewed source", confirmed: true, ...extra } });
const save = (f: Fixture, input = f.input) => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: input });

it("blocks a product without changing physical stock and releases only the expected reviewed revision", async () => {
  const f = await fixture(), before = await Medicine.findById(f.medicine.id), movements = await StockMovement.countDocuments({ medicineId: f.medicine.id });
  const saved = await hold(f); expect(saved.statusCode, saved.body).toBe(200);
  expect(saved.json().data.saleControl).toMatchObject({ blocked: true, revision: 1, changedBy: f.user.id });
  expect((await save(f)).statusCode).toBe(409);
  await expect(dispenseMedicineFEFO(f.medicine.id, f.locationId, 1)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("sale hold") });
  const products = await app.inject({ method: "GET", url: `/api/pharmacy/sales/products?locationId=${f.locationId}&search=Ordinary`, headers: f.headers });
  expect(products.statusCode, products.body).toBe(200); expect(products.body).toContain('"saleBlocked":true'); expect(products.body).toContain('"eligible":false');
  const current = await Medicine.findById(f.medicine.id);
  expect(current).toMatchObject({ stockQuantity: before!.stockQuantity, stockRevision: before!.stockRevision });
  expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(movements);
  expect((await hold(f, f.medicine.id, "medicines", false, 0)).statusCode).toBe(409);
  expect((await hold(f, f.medicine.id, "medicines", false, 1)).statusCode).toBe(200);
  const billed = await save(f); expect(billed.statusCode, billed.body).toBe(201);
  expect(await AuditLog.countDocuments({ targetId: f.medicine.id, action: "PHARMACY_SALE_CONTROL_CHANGED" })).toBe(2);
});

it("a batch hold excludes only that batch and product release cannot clear its independent hold", async () => {
  const f = await fixture(), batch = (await MedicineBatch.findOne({ medicineId: f.medicine.id }))!;
  expect((await hold(f, batch.id, "batches")).statusCode).toBe(200);
  expect((await save(f)).statusCode).toBe(409);
  expect((await hold(f)).statusCode).toBe(200);
  expect((await hold(f, f.medicine.id, "medicines", false, 1)).statusCode).toBe(200);
  expect((await save(f)).statusCode).toBe(409);
  expect((await MedicineBatch.findById(batch.id))!).toMatchObject({ quantity: 10, status: "active", saleControl: { blocked: true } });
  const controls = await app.inject({ method: "GET", url: `/api/pharmacy/medicines/${f.medicine.id}/sale-controls?locationId=${f.locationId}`, headers: f.headers });
  expect(controls.statusCode, controls.body).toBe(200); expect(controls.json().data.batches[0].saleControl.blocked).toBe(true);
  expect((await hold(f, batch.id, "batches", false, 1)).statusCode).toBe(200);
  expect((await save(f)).statusCode).toBe(201);
});

it("billing-only mode still enforces product holds without changing stock", async () => {
  const f = await fixture();
  await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: true, inventoryMode: "billing_only", revision: 1, reviewReference: "Synthetic mode", reviewedAt: new Date(), reviewedBy: f.user.id } } });
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { billingSupply: { batchNumber: "PRINTED-1", expiry: { precision: "month", value: "2099-12" }, mrpPaise: 1200 } } });
  expect((await hold(f)).statusCode).toBe(200);
  expect((await save(f, { ...f.input, expectedInventoryMode: "billing_only" } as typeof f.input)).statusCode).toBe(409);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
});

it("denies cashier writes, foreign branch targets, unconfirmed actions and malformed revisions", async () => {
  const f = await fixture(), foreign = await fixture(), cashier = await pharmacyRetailFixture();
  expect((await hold(cashier)).statusCode).toBe(403);
  expect([403, 404]).toContain((await hold(f, foreign.medicine.id)).statusCode);
  expect((await hold(f, f.medicine.id, "medicines", true, 0, { confirmed: false })).statusCode).toBe(400);
  expect((await hold(f, f.medicine.id, "medicines", true, 0, { expectedRevision: "0" })).statusCode).toBe(400);
  expect(await AuditLog.countDocuments({ organizationId: { $in: [f.organizationId, foreign.organizationId, cashier.organizationId] }, action: "PHARMACY_SALE_CONTROL_CHANGED" })).toBe(0);
});

it("rolls back both the hold and branch stop signal if the required audit fails", async () => {
  const f = await fixture(), create = AuditLog.create.bind(AuditLog);
  const spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => {
    if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_SALE_CONTROL_CHANGED") throw Error("Synthetic audit outage");
    return (create as any)(docs, ...args);
  }) as any);
  try { expect((await hold(f)).statusCode).toBe(500); } finally { spy.mockRestore(); }
  expect((await Medicine.findById(f.medicine.id))!.saleControl).toBeUndefined();
  expect((await Location.findById(f.locationId))!.pharmacySaleControlUpdatedAt).toBeUndefined();
});

it("concurrent opposite actions cannot both overwrite the same sale-control revision", async () => {
  const f = await fixture();
  const responses = await Promise.all([hold(f), hold(f, f.medicine.id, "medicines", false)]);
  expect(responses.map(row => row.statusCode).sort()).toEqual([200, 409]);
  expect((await Medicine.findById(f.medicine.id))!.saleControl?.revision).toBe(1);
  expect(await AuditLog.countDocuments({ action: "PHARMACY_SALE_CONTROL_CHANGED", targetId: f.medicine.id })).toBe(1);
});

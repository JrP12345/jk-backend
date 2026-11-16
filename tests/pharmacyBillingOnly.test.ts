import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";
import { Location } from "../models/Location.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { PharmacyReturn } from "../models/PharmacyReturn.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { receivePharmacyStock } from "../services/PharmacyStockReceiptService.ts";
import { publicPharmacyFlags } from "../utilities/publicPharmacy.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Pick<Awaited<ReturnType<typeof pharmacyRetailFixture>>, "locationId" | "headers">;
const settings = (f: Fixture, inventoryMode: "tracked" | "billing_only", expectedRevision = 0) => app.inject({ method: "PATCH", url: `/api/pharmacy/locations/${f.locationId}/settings`, headers: f.headers, payload: { enabled: true, inventoryMode, expectedRevision, reviewReference: "Synthetic branch mode decision" } });
const save = (f: Fixture, payload: object, reference = key()) => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": reference }, payload });
async function fixture() {
  const f = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "MANAGE_MEDICINES", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_RETURN", "PHARMACY_APPROVE_REFUND", "PHARMACY_VIEW_REPORTS"]);
  const product = await Medicine.create({ locationId: f.locationId, name: "Untracked product", genericName: "Synthetic", stockQuantity: 0, price: 10, scheduleType: "general", unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 }, dispensingRevision: 1, dispensingReview: { scheduleType: "general", confirmedAt: new Date(), confirmedBy: f.user.id, reviewReference: "Synthetic reviewed classification" }, billingSupply: { batchNumber: "PRINTED-LOT", expiry: { precision: "month", value: "2099-12" }, mrpPaise: 1200 } });
  await pharmacyTaxFixture(f.locationId, [product.id], f.user.id);
  const input = { locationId: f.locationId, expectedInventoryMode: "billing_only", confirmationMode: "current_total", expectedTotalPaise: 2000, includeDocument: true, lines: [{ lineId: key(), medicineId: product.id, quantity: 2, expectedUnitVersion: 1, expectedLineTotalPaise: 2000, discountPaise: 0 }] };
  return { ...f, product, input };
}

describe("Whole-branch billing without stock accounting", () => {
  it("requires settings authority, uses a revision CAS, preserves stock and rolls back when its required audit fails", async () => {
    const cashier = await pharmacyRetailFixture();
    expect((await settings(cashier, "billing_only")).statusCode).toBe(403);
    const f = await fixture(), original = (await Medicine.findById(f.medicine.id))!.stockQuantity;
    const create = AuditLog.create.bind(AuditLog), audit = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_CAPABILITY_REVIEWED") throw Error("Synthetic audit failure"); return (create as any)(docs, ...args); }) as any);
    try { expect((await settings(f, "billing_only")).statusCode).toBe(500); } finally { audit.mockRestore(); }
    expect((await Location.findById(f.locationId))!.pharmacyCapability).toBeUndefined();
    const result = await settings(f, "billing_only"); expect(result.statusCode, result.body).toBe(200);
    expect(result.json().data).toMatchObject({ inventoryMode: "billing_only", revision: 1, actions: { sell: true, receiveStock: false, adjustStock: false, transferStock: false } });
    expect((await settings(f, "tracked", 0)).statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(original);
    expect((await settings(f, "tracked", 1)).statusCode).toBe(200); // No untracked supply has happened yet.
  });

  it("saves and prints a zero-stock product with an atomic payment, no stock writes and the same replay/recovery evidence", async () => {
    const f = await fixture(); expect((await settings(f, "billing_only")).statusCode).toBe(200);
    const movements = await StockMovement.countDocuments({ locationId: f.locationId }), batches = await MedicineBatch.countDocuments({ locationId: f.locationId });
    const metadataAudits = await AuditLog.countDocuments({ targetId: f.product.id, action: "MEDICINE_UPDATE" });
    const input = { ...f.input, payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 2500, entries: [{ componentId: key(), amountPaise: 2000, paymentMethod: "cash" }] } }, reference = key();
    const response = await save(f, input, reference); expect(response.statusCode, response.body).toBe(201);
    const result = response.json().data;
    expect(result).toMatchObject({ status: "paid", totalPaise: 2000, collection: { cashChangePaise: 500 }, document: { items: [{ batches: [{ batchNumber: "PRINTED-LOT", expiryValue: "2099-12", mrpPaise: 1200, sellingPricePaise: 1000, quantity: 2 }] }] } });
    expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(movements);
    expect(await MedicineBatch.countDocuments({ locationId: f.locationId })).toBe(batches);
    expect(await AuditLog.countDocuments({ targetId: f.product.id, action: "MEDICINE_UPDATE" })).toBe(metadataAudits); // A technical lock is not a catalogue edit.
    expect((await Medicine.findById(f.product.id))!).toMatchObject({ stockQuantity: 0, stockRevision: 0 });
    expect((await PharmacyDispense.findById(result.dispenseId))!).toMatchObject({ inventoryMode: "billing_only", lines: [{ batches: [] }] });
    expect((await save(f, input, reference)).json().data).toEqual({ ...result, replayed: true });
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/sale-operations/${reference}?locationId=${f.locationId}`, headers: f.headers })).json().data.invoiceId).toBe(result.invoiceId);
    expect((await settings(f, "tracked", 1)).statusCode).toBe(409);
  });

  it("accepts catalogue supply details through the product API without requiring opening stock or allowing numeric coercion", async () => {
    const f = await fixture(); await settings(f, "billing_only");
    const payload = { locationId: f.locationId, name: "Catalogue-only item", genericName: "Synthetic", price: 10, stockQuantity: 0, unitDefinition: { baseUnit: "piece", packUnit: "box", unitsPerPack: 10 }, billingSupply: { batchNumber: "PRINTED-1", expiry: { precision: "month", value: "2099-12" }, mrpPaise: 1200 } };
    const created = await app.inject({ method: "POST", url: "/api/medicines", headers: f.headers, payload });
    expect(created.statusCode, created.body).toBe(201); const product = created.json().data;
    expect(product).toMatchObject({ stockQuantity: 0, billingSupply: payload.billingSupply });
    expect(await MedicineBatch.countDocuments({ medicineId: product.id })).toBe(0);
    const update = (billingSupply: object) => app.inject({ method: "PUT", url: `/api/medicines/${product.id}`, headers: f.headers, payload: { billingSupply } });
    expect((await update({ ...payload.billingSupply, mrpPaise: "1200" })).statusCode).toBe(400);
    expect((await update({ ...payload.billingSupply, expiry: { precision: "month", value: "2099-13" } })).statusCode).toBe(400);
    const updated = await update({ ...payload.billingSupply, batchNumber: "PRINTED-2" }); expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().data.billingSupply.batchNumber).toBe("PRINTED-2");
    expect(await StockMovement.countDocuments({ medicineId: product.id })).toBe(0);
  });

  it("rejects stale mode, missing/expired supply evidence, MRP excess, restricted products, foreign products and changed prices without issuing a bill", async () => {
    const f = await fixture();
    expect((await save(f, f.input)).statusCode).toBe(409);
    expect((await settings(f, "billing_only")).statusCode).toBe(200);
    expect((await save(f, { ...f.input, expectedInventoryMode: "tracked" })).statusCode).toBe(409);
    const supply = f.product.billingSupply!;
    for (const change of [{ $unset: { billingSupply: "" } }, { $set: { "billingSupply.expiry.value": "2000-01" } }, { $set: { "billingSupply.mrpPaise": 999 } }, { $set: { scheduleType: "schedule_h" } }]) {
      await Medicine.updateOne({ _id: f.product.id }, change);
      expect((await save(f, f.input)).statusCode).toBe(409);
      await Medicine.updateOne({ _id: f.product.id }, { $set: { billingSupply: supply, scheduleType: "general" } });
    }
    const foreign = await fixture();
    expect((await save(f, { ...f.input, lines: [{ ...f.input.lines[0], medicineId: foreign.product.id }] })).statusCode).toBe(409);
    await Medicine.updateOne({ _id: f.product.id }, { $set: { price: 11 } });
    const changed = await save(f, f.input); expect(changed.statusCode).toBe(409); expect(changed.json().code || changed.json().details?.code || changed.body).toBeTruthy();
    expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  });

  it("quotes fresh catalogue prices, blocks receiving and public stock promises, and leaves financial reports available", async () => {
    const f = await fixture(); await settings(f, "billing_only");
    const quote = await app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload: { locationId: f.locationId, expectedInventoryMode: "billing_only", lines: f.input.lines.map(({ expectedLineTotalPaise: _amount, ...line }) => line) } });
    expect(quote.statusCode, quote.body).toBe(200); expect(quote.json().data.issueInput.expectedInventoryMode).toBe("billing_only");
    // A correction to retained historical stock must not become a billing-only quote assertion.
    await Medicine.collection.updateOne({ _id: f.product._id }, { $set: { stockQuantity: 42, stockRevision: 42 } });
    expect((await save(f, quote.json().data.issueInput)).statusCode).toBe(201);
    expect((await Medicine.findById(f.product.id))!).toMatchObject({ stockQuantity: 42, stockRevision: 42 });
    await expect(receivePharmacyStock({ organizationId: f.organizationId, locationId: f.locationId, actorId: f.user.id }, key(), { locationId: f.locationId, medicineId: f.product.id, receiptLineId: key(), kind: "opening", expectedUnitVersion: 1, packs: 1, looseUnits: 0, batchNumber: "NEW", expiry: { precision: "month", value: "2099-12" }, purchaseTotalPaise: 100, sellingPricePaise: 1000, mrpPaise: 1200, openingSourceReference: "Synthetic count" })).rejects.toThrow(/billing-only/);
    expect(publicPharmacyFlags({ publicPharmacy: { catalogueEnabled: true, pickupEnabled: true }, pharmacyCapability: { enabled: true, inventoryMode: "billing_only" } })).toEqual({ catalogueEnabled: true, pickupEnabled: false });
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/expiring?locationId=${f.locationId}`, headers: f.headers })).statusCode).toBe(409);
    const reports = await app.inject({ method: "GET", url: `/api/pharmacy/reports?locationId=${f.locationId}`, headers: f.headers });
    expect(reports.statusCode, reports.body).toBe(200);
    expect(reports.json().data.items.map((row: any) => row.kind)).toContain("sales");
    expect(reports.json().data.items.map((row: any) => row.kind)).not.toContain("stock");
  });

  it("rolls back an in-flight untracked sale when the branch mode changes before commit", async () => {
    const f = await fixture(); await settings(f, "billing_only");
    let reached = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), write = Location.findOneAndUpdate.bind(Location);
    const spy = vi.spyOn(Location, "findOneAndUpdate").mockImplementation(((filter: any, update: any, options: any) => {
      if (!reached && String(filter._id) === f.locationId && update.$inc?.__v === 1) { reached = true; return gate.then(() => (write as any)(filter, update, options)); }
      return (write as any)(filter, update, options);
    }) as any);
    const pending = Promise.resolve(save(f, f.input));
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      // Inject the committed configuration write directly: the API's required issuer/audit locks
      // also serialize settings with Save and must not be held behind this test's artificial gate.
      const changed = await Location.collection.updateOne({ _id: new mongoose.Types.ObjectId(f.locationId) }, { $set: { "pharmacyCapability.enabled": false, "pharmacyCapability.inventoryMode": "tracked", "pharmacyCapability.revision": 2 } });
      expect(changed.modifiedCount).toBe(1);
      release();
      const response = await pending; expect(response.statusCode, response.body).toBe(409);
    } finally { release(); spy.mockRestore(); }
    expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
    expect(await PharmacyDispense.countDocuments({ locationId: f.locationId })).toBe(0);
    expect((await Medicine.findById(f.product.id))!.stockQuantity).toBe(0);
  });

  it("credits billing-only returns once without restocking, while old tracked supplies still return to quarantine", async () => {
    const f = await fixture(), tracked = await save(f, { ...f.input, expectedInventoryMode: "tracked", lines: [{ ...f.input.lines[0], medicineId: f.medicine.id }] });
    expect(tracked.statusCode, tracked.body).toBe(201); await settings(f, "billing_only");
    const untracked = await save(f, f.input); expect(untracked.statusCode, untracked.body).toBe(201);
    for (const [sale, trackedReturn] of [[untracked, false], [tracked, true]] as const) {
      const invoiceId = sale.json().data.invoiceId, path = `/api/pharmacy/invoices/${invoiceId}`, source = await app.inject({ method: "GET", url: `${path}/return-source?locationId=${f.locationId}`, headers: f.headers });
      expect(source.statusCode, source.body).toBe(200); const row = source.json().data.lines[0], before = await StockMovement.countDocuments({ locationId: f.locationId });
      const payload = { locationId: f.locationId, reason: "Goods physically returned", reviewReference: "Synthetic approval", confirmedQuarantine: true, lines: [{ sourceLineId: row.sourceLineId, sourceBatchId: row.sourceBatchId, quantity: 1, condition: "unopened" }] };
      const quote = await app.inject({ method: "POST", url: `${path}/returns/quote`, headers: f.headers, payload }); expect(quote.statusCode, quote.body).toBe(200);
      const reference = key(), commit = () => app.inject({ method: "POST", url: `${path}/returns`, headers: { ...f.headers, "idempotency-key": reference }, payload: quote.json().data.issueInput });
      const returned = await commit(); expect(returned.statusCode, returned.body).toBe(201); expect(returned.json().data.creditedPaise).toBe(1000);
      expect((await commit()).json().data.returnId).toBe(returned.json().data.returnId);
      expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(before + (trackedReturn ? 1 : 0));
      const record = await PharmacyReturn.findById(returned.json().data.returnId);
      expect(Boolean(record!.lines[0].quarantineBatchId)).toBe(trackedReturn);
    }
    expect((await Medicine.findById(f.product.id))!.stockQuantity).toBe(0);
  });

  it("rechecks a catalogue price changed between its snapshot read and technical lock", async () => {
    const f = await fixture(); await settings(f, "billing_only");
    let reached = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), write = Medicine.collection.updateOne.bind(Medicine.collection);
    const spy = vi.spyOn(Medicine.collection, "updateOne").mockImplementation(((filter: any, update: any, options: any) => {
      if (!reached && String(filter._id) === f.product.id && update.$inc?.__v === 1) { reached = true; return gate.then(() => (write as any)(filter, update, options)); }
      return (write as any)(filter, update, options);
    }) as any);
    const pending = Promise.resolve(save(f, f.input));
    try {
      await vi.waitFor(() => expect(reached).toBe(true));
      await Medicine.collection.updateOne({ _id: f.product._id }, { $set: { price: 11 } });
      release(); const response = await pending; expect(response.statusCode, response.body).toBe(409); expect(response.body).toContain("COUNTER_TOTAL_CHANGED");
    } finally { release(); spy.mockRestore(); }
    expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
    expect((await Medicine.findById(f.product.id))!).toMatchObject({ stockQuantity: 0, stockRevision: 0, price: 11 });
  });

  it("rolls back the untracked source and technical lock if the required issued-supply audit fails", async () => {
    const f = await fixture(); await settings(f, "billing_only");
    const original = await Medicine.collection.findOne({ _id: f.product._id }), create = AuditLog.create.bind(AuditLog);
    const audit = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_COUNTER_INVOICE_ISSUED") throw Error("Synthetic required issue audit failure"); return (create as any)(docs, ...args); }) as any);
    try { expect((await save(f, f.input)).statusCode).toBe(500); } finally { audit.mockRestore(); }
    expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
    expect(await PharmacyDispense.countDocuments({ locationId: f.locationId })).toBe(0);
    expect((await Medicine.collection.findOne({ _id: f.product._id }))!.__v).toBe(original!.__v);
  });
});

import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import { Invoice } from "../models/Invoice.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { StockMovement } from "../models/StockMovement.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const intent = (f: Fixture) => ({ locationId: f.locationId, lines: f.input.lines.map(({ lineId, medicineId, quantity, expectedUnitVersion, discountPaise }) => ({ lineId, medicineId, quantity, expectedUnitVersion, discountPaise })) });
const quote = (f: Fixture, payload: object = intent(f)) => app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload });
const issue = (f: Fixture, payload: object, key = crypto.randomUUID()) => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key }, payload });
const lookup = (f: Fixture, path: string) => app.inject({ method: "GET", url: `/api/pharmacy/sales/${path}${path.includes("?") ? "&" : "?"}locationId=${f.locationId}`, headers: f.headers });
describe("Trusted keyboard counter quote and bounded lookup", () => {
  it("quotes current FEFO price without writing stock, profile, invoice, receipt or numbering, then issues exactly the quote", async () => {
    const f = await fixture(), profile = await PharmacyTaxProfile.findOne({ locationId: f.locationId }).lean(), movements = await StockMovement.countDocuments({ medicineId: f.medicine.id });
    const result = await quote(f); expect(result.statusCode, result.body).toBe(200); expect(result.headers["cache-control"]).toBe("no-store");
    const q = result.json().data; expect(q).toMatchObject({ currency: "INR", calculation: { totals: { payablePaise: 2000 } }, issueInput: { expectedTotalPaise: 2000, expectedProfileRevision: 1, lines: [{ expectedStockRevision: 1, expectedUnitVersion: 1 }] }, lines: [{ batches: [{ batchNumber: "ACTUAL-BATCH", quantity: 2, sellingPricePaise: 1000 }] }] });
    expect(await PharmacyTaxProfile.findOne({ locationId: f.locationId }).lean()).toEqual(profile); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(movements); expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await OperationReceipt.countDocuments({ scope: `pharmacy-sale:${f.organizationId}:${f.locationId}` })).toBe(0);
    const saved = await issue(f, q.issueInput); expect(saved.statusCode, saved.body).toBe(201); expect(saved.json().data.totalPaise).toBe(2000);
  });
  it("rejects stale stock and a changed quote fingerprint even when the total stays the same", async () => {
    const f = await fixture(), q = (await quote(f)).json().data;
    expect((await issue(f, { ...q.issueInput, expectedQuoteHash: "0".repeat(64) })).statusCode).toBe(409);
    const first = await issue(f, q.issueInput); expect(first.statusCode, first.body).toBe(201);
    expect((await issue(f, q.issueInput)).statusCode).toBe(409); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
    const next = (await quote(f)).json().data, second = await issue(f, next.issueInput); expect(second.statusCode, second.body).toBe(201); expect(second.json().data.invoiceId).not.toBe(first.json().data.invoiceId);
  });
  it("captures customer revision and invalidates quote after customer or issuer changes", async () => {
    const f = await fixture(), party = await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Counter customer", normalizedName: "counter customer", address: "Actual address", kinds: ["customer"], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
    const q = (await quote(f, { ...intent(f), customerId: party.id })).json().data; expect(q.customer).toMatchObject({ id: party.id, revision: 0 });
    await PharmacyParty.updateOne({ _id: party.id }, { $inc: { revision: 1 } }); expect((await issue(f, q.issueInput)).statusCode).toBe(409);
    const next = (await quote(f)).json().data; await PharmacyTaxProfile.updateOne({ locationId: f.locationId }, { $inc: { revision: 1 } }); expect((await issue(f, next.issueInput)).statusCode).toBe(409);
  });
  it("keeps barcode equality and leading zeroes, projects no acquisition fields and bounds product pages", async () => {
    const f = await fixture(); await Medicine.updateOne({ _id: f.medicine.id }, { $set: { barcodes: ["000123"], costPrice: 1 } });
    const exact = await lookup(f, "products?barcode=000123"); expect(exact.statusCode).toBe(200); expect(exact.json().data.items).toMatchObject([{ id: f.medicine.id, eligible: true, unitDefinition: { unitsPerPack: 10 } }]); expect(exact.body).not.toContain("costPrice");
    expect((await lookup(f, "products?barcode=123")).json().data.items).toEqual([]); expect((await lookup(f, "products?barcode=Ordinary%20product")).json().data.items).toEqual([]);
    expect((await lookup(f, "products?search=%5B")).json().data.items).toEqual([]);
    await Medicine.insertMany(Array.from({ length: 28 }, (_, i) => ({ locationId: f.locationId, name: `Bounded ${i}`, genericName: "Synthetic", stockQuantity: 0, price: 0 })));
    const page = (await lookup(f, "products?search=Bounded")).json().data; expect(page.items).toHaveLength(25); expect(page.nextCursor).toBeTruthy();
    expect((await lookup(f, `products?search=Bounded&cursor=${page.nextCursor}`)).json().data.items).toHaveLength(3);
  });
  it("customer lookup exposes only active branch customers without supplier licences or GST business identities", async () => {
    const f = await fixture();
    for (const [name, kinds, extra] of [["Visible customer", ["customer"], {}], ["Supplier", ["supplier"], {}], ["Archived", ["customer"], { archived: true }], ["Business", ["customer"], { gstin: "27ABCDE1234F1Z5" }]] as const) await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name, normalizedName: name.toLowerCase(), address: "Actual address", kinds: [...kinds], gstRegistration: "unregistered", licence: { number: "Secret supplier licence" }, createdBy: f.user.id, updatedBy: f.user.id, ...extra });
    const result = await lookup(f, "customers"); expect(result.statusCode).toBe(200); expect(result.json().data.items).toMatchObject([{ name: "Visible customer" }]); expect(result.json().data.items).toHaveLength(1); expect(result.body).not.toContain("licence");
    expect((await lookup(f, "customers?search=Visible")).json().data.items).toHaveLength(1);
  });
  it("rejects foreign branch products and customer IDs, and collection-only staff cannot quote or search", async () => {
    const f = await fixture(), foreign = await fixture(), onlyCollect = await fixture(["PHARMACY_COLLECT_PAYMENT"]);
    expect((await quote(f, { ...intent(f), lines: [{ ...intent(f).lines[0], medicineId: foreign.medicine.id }] })).statusCode).toBe(409);
    expect((await quote(f, { ...intent(f), customerId: foreign.user.id })).statusCode).toBe(409);
    expect((await lookup(onlyCollect, "products")).statusCode).toBe(403); expect((await lookup(onlyCollect, "customers")).statusCode).toBe(403); expect((await quote(onlyCollect)).statusCode).toBe(403);
    expect((await lookup(f, `products?barcode=000123&locationId=${foreign.locationId}`)).statusCode).toBe(400);
  });
  it("does not quote restricted, unavailable or invalid inventory and never falls back to aggregate stock", async () => {
    const f = await fixture(); await Medicine.updateOne({ _id: f.medicine.id }, { $set: { scheduleType: "schedule_h" } }); expect((await quote(f)).statusCode).toBe(409);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { scheduleType: "general" } }); await MedicineBatch.updateOne({ medicineId: f.medicine.id }, { $set: { status: "quarantined" } }); expect((await quote(f)).statusCode).toBe(409);
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("rejects quantity conversion from an obsolete displayed unit definition", async () => {
    const f = await fixture(), old = intent(f); old.lines[0].expectedUnitVersion = 2;
    expect((await quote(f, old)).statusCode).toBe(409); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  });
  it("quotes and issues the same ordered lots when an ordinary product spans different selling prices", async () => {
    const f = await fixture(), original = await MedicineBatch.findOne({ medicineId: f.medicine.id }).lean();
    const { _id, ...captured } = original!;
    // Synthetic second owned lot; shared printed batch identity must not collapse valuation lots.
    await MedicineBatch.create({ ...captured, receiptLineId: crypto.randomUUID(), receivedAt: new Date(original!.receivedAt!.getTime() - 1000), sellingPrice: 20, sellingPricePaise: 2000, mrp: 25, mrpPaise: 2500 });
    await Medicine.updateOne({ _id: f.medicine.id }, { $inc: { stockQuantity: 10, stockRevision: 1 } });
    const input = intent(f); input.lines[0].quantity = 12;
    const quoted = await quote(f, input); expect(quoted.statusCode, quoted.body).toBe(200); const q = quoted.json().data;
    expect(q.calculation.totals.payablePaise).toBe(22000); expect(q.lines[0].batches).toMatchObject([{ quantity: 10, sellingPricePaise: 2000 }, { quantity: 2, sellingPricePaise: 1000 }]);
    const result = await issue(f, q.issueInput); expect(result.statusCode, result.body).toBe(201); expect(result.json().data.totalPaise).toBe(22000); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
    const capability = await app.inject({ method: "GET", url: `/api/pharmacy/locations/${f.locationId}/capabilities`, headers: f.headers }); expect(capability.json().data.counterSalesAvailable).toBe(true);
  });
  it("a full discount settles a zero-total document without inventing a payment receipt", async () => {
    const f = await fixture(), q = (await quote(f, { ...intent(f), invoiceDiscountPaise: 2000 })).json().data;
    const result = await issue(f, q.issueInput); expect(result.statusCode, result.body).toBe(201);
    const invoice = await Invoice.findById(result.json().data.invoiceId); expect(invoice).toMatchObject({ totalAmount: 0, status: "paid", balanceDue: 0, payments: [] });
  });
  it.each([{ expectedTotalPaise: 1 }, { expectedProfileRevision: 1 }, { actorId: "forged" }, { lines: [{ medicineId: "bad", quantity: "2" }] }, { roundOffPaise: 100 }])("rejects quote authority/price injection or invalid intent %j", async extra => {
    const f = await fixture(); expect((await quote(f, { ...intent(f), ...extra })).statusCode).toBe(400);
  });
});

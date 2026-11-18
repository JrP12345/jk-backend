import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import { Invoice } from "../models/Invoice.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";
import { PHARMACY_ROLE_PRESETS } from "../utilities/pharmacyPermissions.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const intent = (f: Fixture) => ({ locationId: f.locationId, lines: f.input.lines.map(({ lineId, medicineId, quantity, expectedUnitVersion, discountPaise }) => ({ lineId, medicineId, quantity, expectedUnitVersion, discountPaise })) });
const quote = (f: Fixture, payload: object = intent(f)) => app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload });
const issue = (f: Fixture, payload: object, key = crypto.randomUUID()) => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key }, payload });
const lookup = (f: Fixture, path: string) => app.inject({ method: "GET", url: `/api/pharmacy/sales/${path}${path.includes("?") ? "&" : "?"}locationId=${f.locationId}`, headers: f.headers });
describe("Trusted keyboard counter quote and bounded lookup", () => {
  it("finds older branch sales across pages, filters payment states and escapes literal search text", async () => {
    const f = await fixture(), foreign = await fixture();
    // Read-only listing fixture: no sale, payment or stock command is invoked.
    const rows = Array.from({ length: 30 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), kind: "pharmacy", organizationId: new mongoose.Types.ObjectId(f.organizationId), locationId: new mongoose.Types.ObjectId(f.locationId), deletedAt: null,
      invoiceNumber: index === 0 ? "OLD-ONLY/[001]" : `SYNTHETIC-${index}`, status: ["unpaid", "paid", "partially_paid"][index % 3], totalAmount: 10, currency: "INR", customerSnapshot: { anonymous: false, name: index === 0 ? "Old page customer" : "Synthetic customer" } }));
    await Invoice.collection.insertMany([...rows, { ...rows[0], _id: new mongoose.Types.ObjectId(), organizationId: new mongoose.Types.ObjectId(foreign.organizationId), locationId: new mongoose.Types.ObjectId(foreign.locationId) }]);
    const read = (params = "", headers = f.headers) => app.inject({ method: "GET", url: `/api/pharmacy/invoices?locationId=${f.locationId}${params}`, headers });
    const first = await read(); expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.items.map((row: { id: string }) => row.id)).toEqual([...rows].reverse().slice(0, 25).map(row => String(row._id)));
    const second = await read(`&cursor=${first.json().data.nextCursor}`);
    expect(second.json().data.items.map((row: { id: string }) => row.id)).toEqual([...rows].reverse().slice(25).map(row => String(row._id)));
    expect(second.json().data.nextCursor).toBeNull();
    const old = await read(`&search=${encodeURIComponent("old-only/[001]")}`);
    expect(old.json().data.items.map((row: { id: string }) => row.id)).toEqual([String(rows[0]._id)]);
    expect((await read("&search=Old%20page%20customer")).json().data.items).toHaveLength(1);
    expect((await read("&search=.*")).json().data.items).toEqual([]);
    expect((await read("&status=paid")).json().data.items).toHaveLength(10);
    const unpaid = (await read("&status=unpaid")).json().data.items;
    expect(unpaid).toHaveLength(20); expect(unpaid.some((row: { status: string }) => row.status === "partially_paid")).toBe(true);
    expect((await read("&status=unknown")).statusCode).toBe(400);
    expect((await read(`&search=${"a".repeat(101)}`)).statusCode).toBe(400);
    expect((await read("", foreign.headers)).statusCode).toBe(404);
  });
  it("returns newly committed sale and collection results without redundant recovery reads, preserving replay", async () => {
    const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), checked = await quote(f), saleKey = crypto.randomUUID();
    const saleReads = vi.spyOn(OperationReceipt, "findOne");
    let saved;
    try { saved = await issue(f, checked.json().data.issueInput, saleKey); expect(saved.statusCode, saved.body).toBe(201); expect(saleReads).toHaveBeenCalledTimes(2); }
    finally { saleReads.mockRestore(); }
    const sale = saved!.json().data, paymentKey = crypto.randomUUID();
    const payload = { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 2500, entries: [{ componentId: crypto.randomUUID(), amountPaise: 2000, paymentMethod: "cash" }] };
    const collect = () => app.inject({ method: "POST", url: `/api/pharmacy/invoices/${sale.invoiceId}/collections`, headers: { ...f.headers, "idempotency-key": paymentKey }, payload });
    const paymentReads = vi.spyOn(OperationReceipt, "findOne");
    let paid;
    try { paid = await collect(); expect(paid.statusCode, paid.body).toBe(201); expect(paymentReads).toHaveBeenCalledTimes(1); }
    finally { paymentReads.mockRestore(); }
    expect((await issue(f, checked.json().data.issueInput, saleKey)).json().data).toEqual({ ...sale, replayed: true });
    expect((await collect()).json().data).toEqual({ ...paid!.json().data, replayed: true });
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });
  it("loads only the selected customer's branch bills newest first with bounded cursor pagination", async () => {
    const f = await fixture();
    const makeCustomer = (name: string) => PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name, normalizedName: name.toLowerCase(), address: "Synthetic address", kinds: ["customer"], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
    const customer = await makeCustomer("History customer"), other = await makeCustomer("Other customer");
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { stockQuantity: 100 } });
    await MedicineBatch.updateOne({ medicineId: f.medicine.id }, { $set: { quantity: 100 } });
    const ids: string[] = [];
    for (let index = 0; index < 28; index++) {
      const payload = { ...intent(f), ...(index ? { customerId: index === 1 ? other.id : customer.id } : {}), lines: intent(f).lines.map(line => ({ ...line, quantity: 1 })) };
      const checked = await quote(f, payload); expect(checked.statusCode, checked.body).toBe(200);
      const saved = await issue(f, checked.json().data.issueInput); expect(saved.statusCode, saved.body).toBe(201);
      if (index > 1) ids.push(saved.json().data.invoiceId);
    }
    const history = (id: string, cursor = "") => app.inject({ method: "GET", url: `/api/pharmacy/invoices?locationId=${f.locationId}&customerId=${id}${cursor ? `&cursor=${cursor}` : ""}`, headers: f.headers });
    const first = await history(customer.id); expect(first.statusCode, first.body).toBe(200); expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.json().data).toMatchObject({ locationId: f.locationId, customerId: customer.id });
    expect(first.json().data.items.map((row: { id: string }) => row.id)).toEqual([...ids].reverse().slice(0, 25));
    expect(first.json().data.items[0]).toMatchObject({ amountPaid: 0, balanceDue: 10, totalAmount: 10 });
    const second = await history(customer.id, first.json().data.nextCursor); expect(second.json().data.items.map((row: { id: string }) => row.id)).toEqual([ids[0]]); expect(second.json().data.nextCursor).toBeNull();
    expect((await history(new mongoose.Types.ObjectId().toString())).statusCode).toBe(404);
    expect((await history("invalid-customer")).statusCode).toBe(400);
    const foreign = await fixture();
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/invoices?locationId=${f.locationId}&customerId=${customer.id}`, headers: foreign.headers })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/invoices?locationId=${foreign.locationId}&customerId=${customer.id}`, headers: f.headers })).statusCode).toBe(404);
  });
  it("exposes a bounded retail display price without acquisition fields or changing batch quote authority", async () => {
    const f = await fixture(["VIEW_LOCATIONS", "PHARMACY_SELL"]);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { price: 15.25, costPrice: 2 } });
    const result = await lookup(f, "products");
    expect(result.statusCode).toBe(200);
    expect(result.json().data.items[0]).toMatchObject({ id: f.medicine.id, retailPricePaise: 1525 });
    expect(result.body).not.toMatch(/costPrice|purchaseCost|expectedQuoteHash/);
    const checked = await quote(f);
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json().data.lines[0].batches[0].sellingPricePaise).toBe(1000);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { price: 15.234 } });
    const unavailable = await lookup(f, "products");
    expect(unavailable.statusCode).toBe(200);
    expect(unavailable.json().data.items[0]).not.toHaveProperty("retailPricePaise");
  });
  it("completes a counter-only shift while denying inventory, costs, setup, returns, finance and cash movements", async () => {
    const preset = PHARMACY_ROLE_PRESETS.find(role => role.name === "pharmacy_counter_sales")!;
    expect(preset.permissions).toEqual(["VIEW_LOCATIONS", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_CLOSE_TILL"]);
    const f = await fixture(preset.permissions);
    const get = (path: string) => app.inject({ method: "GET", url: `/api/${path}${path.includes("?") ? "&" : "?"}locationId=${f.locationId}`, headers: f.headers });
    const post = (path: string, payload: object) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: { locationId: f.locationId, ...payload } });
    const caps = await get(`pharmacy/locations/${f.locationId}/capabilities`);
    expect(caps.statusCode, caps.body).toBe(200);
    expect(caps.json().data.actions).toMatchObject({ sell: true, collect: true, viewSales: true, viewTill: true, openTill: true, closeTill: true,
      viewStock: false, viewCost: false, manageCatalog: false, receiveStock: false, viewRxQueue: false, viewPurchases: false, viewReturns: false, viewSettlements: false, viewReports: false, moveTillCash: false, manageSettings: false });
    expect(caps.json().data.importKinds).toEqual([]);
    const products = await lookup(f, "products"); expect(products.statusCode, products.body).toBe(200);
    expect(products.json().data.items[0]).toMatchObject({ id: f.medicine.id, eligible: true }); expect(products.body).not.toMatch(/costPrice|purchaseCost/);
    for (const path of ["medicines", "pharmacy/purchases", "pharmacy/return-invoices", "pharmacy/settlement-parties", "pharmacy/reports", `pharmacy/locations/${f.locationId}/settings`, "pharmacy/pending-prescriptions"]) {
      const denied = await get(path); expect(denied.statusCode, `${path}: ${denied.body}`).toBe(403);
    }
    const branches = await get("onboarding/locations"); expect(branches.statusCode, branches.body).toBe(200);
    expect(branches.json().data.map((branch: { id: string }) => branch.id)).toEqual([f.locationId]);
    const sibling = await Location.create({ organizationId: f.organizationId, name: "Not assigned", city: "Pune" });
    const unassigned = await app.inject({ method: "GET", url: `/api/pharmacy/sales/products?locationId=${sibling.id}`, headers: f.headers }); expect(unassigned.statusCode).toBe(404);
    const quoted = await quote(f); expect(quoted.statusCode, quoted.body).toBe(200);
    const saved = await issue(f, quoted.json().data.issueInput); expect(saved.statusCode, saved.body).toBe(201);
    const invoiceId = saved.json().data.invoiceId;
    const payment = await post(`invoices/${invoiceId}/collections`, { expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 2000, entries: [{ componentId: crypto.randomUUID(), amountPaise: 2000, paymentMethod: "cash" }] });
    expect(payment.statusCode, payment.body).toBe(201); expect(payment.json().data.status).toBe("paid");
    const history = await get("pharmacy/invoices"); expect(history.statusCode, history.body).toBe(200); expect(history.json().data.items).toHaveLength(1);
    const active = await get("pharmacy/till"); expect(active.statusCode, active.body).toBe(200); const drawer = active.json().data.active;
    expect(drawer.cashierId).toBe(f.user.id); expect(drawer.drawerTotals.expectedCashPaise).toBe(102000);
    expect((await post(`till/${drawer.id}/movements`, { expectedRevision: drawer.revision, direction: "out", amountPaise: 100, referenceNumber: "TEST", reviewReference: "Synthetic" })).statusCode).toBe(403);
    const closed = await post(`till/${drawer.id}/close`, { expectedRevision: drawer.revision, countedCashPaise: 102000 }); expect(closed.statusCode, closed.body).toBe(201);
    const opened = await post("till/open", { drawerCode: "COUNTER-02", openingFloatPaise: 100000 }); expect(opened.statusCode, opened.body).toBe(201);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: [] } });
    expect((await lookup(f, "products")).statusCode).toBe(403); expect((await quote(f)).statusCode).toBe(403); expect((await get("pharmacy/till")).statusCode).toBe(403);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });
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
    const exact = await lookup(f, "products?barcode=000123"); expect(exact.statusCode).toBe(200); expect(exact.json().data.items).toMatchObject([{ id: f.medicine.id, eligible: true, barcodes: ["000123"], unitDefinition: { unitsPerPack: 10 } }]); expect(exact.body).not.toContain("costPrice");
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

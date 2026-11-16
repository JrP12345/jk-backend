import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import { Invoice } from "../models/Invoice.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function confirmed(f: Fixture, paymentMethod: "cash" | "upi" | "card" = "cash") {
  const quote = await app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload: { locationId: f.locationId, lines: f.input.lines.map(({ expectedStockRevision: _revision, ...line }) => line) } });
  expect(quote.statusCode, quote.body).toBe(200);
  return { ...quote.json().data.issueInput, payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true,
    cashTenderedPaise: paymentMethod === "cash" ? 2500 : 0, entries: [{ componentId: crypto.randomUUID(), amountPaise: 2000, paymentMethod, ...(paymentMethod !== "cash" ? { referenceNumber: "VERIFIED-123" } : {}) }] } };
}
const save = (f: Fixture, payload: object, key = crypto.randomUUID()) => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key }, payload });
async function emptySale(f: Fixture) {
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
  expect(await PharmacyDispense.countDocuments({ organizationId: f.organizationId })).toBe(0);
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(0);
  expect(await OperationReceipt.countDocuments({ scope: `pharmacy-sale:${f.organizationId}:${f.locationId}` })).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect((await MedicineBatch.findOne({ medicineId: f.medicine.id }))!.quantity).toBe(10);
}

it.each(["cash", "upi", "card"] as const)("commits one %s payment with the bill, stock and receipt and recovers the same committed evidence", async method => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), input = await confirmed(f, method), key = crypto.randomUUID();
  const saved = await save(f, input, key); expect(saved.statusCode, saved.body).toBe(201);
  const result = saved.json().data;
  expect(result).toMatchObject({ status: "paid", totalPaise: 2000, requestKey: key, collection: { invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber, status: "paid", collectedPaise: 2000, balancePaise: 0, revision: 1, cashChangePaise: method === "cash" ? 500 : 0, entries: input.payment.entries, requestKey: key } });
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(1);
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(1);
  expect((await Invoice.findById(result.invoiceId))!.amountPaid).toBe(20);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  const replay = await save(f, input, key); expect(replay.statusCode, replay.body).toBe(201); expect(replay.json().data).toEqual({ ...result, replayed: true });
  const recovery = await app.inject({ method: "GET", url: `/api/pharmacy/sale-operations/${key}?locationId=${f.locationId}`, headers: f.headers });
  expect(recovery.statusCode, recovery.body).toBe(200); expect(recovery.json().data).toEqual({ ...result, replayed: undefined });
  const drawer = await app.inject({ method: "GET", url: `/api/pharmacy/till?locationId=${f.locationId}`, headers: f.headers });
  expect(drawer.json().data.active.drawerTotals.expectedCashPaise).toBe(method === "cash" ? 102000 : 100000);
  expect((await save(f, { ...input, payment: { ...input.payment, cashTenderedPaise: method === "cash" ? 3000 : 1 } }, key)).statusCode).toBe(method === "cash" ? 409 : 400);
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(1);
});

it("rolls back the new bill and inventory when the drawer closed after confirmation", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_CLOSE_TILL"]), input = await confirmed(f);
  const active = await app.inject({ method: "GET", url: `/api/pharmacy/till?locationId=${f.locationId}`, headers: f.headers }), drawer = active.json().data.active;
  const closed = await app.inject({ method: "POST", url: `/api/pharmacy/till/${drawer.id}/close`, headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: { locationId: f.locationId, expectedRevision: drawer.revision, countedCashPaise: 100000 } });
  expect(closed.statusCode, closed.body).toBe(201);
  const failed = await save(f, input); expect(failed.statusCode, failed.body).toBe(428); await emptySale(f);
});

it("rolls back all sale, receipt and stock changes if the required payment audit fails", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), input = await confirmed(f), key = crypto.randomUUID();
  const create = AuditLog.create.bind(AuditLog);
  const audit = vi.spyOn(AuditLog, "create").mockImplementation((...args: any[]) => {
    const doc = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (doc?.action === "PHARMACY_INVOICE_COLLECTION") return Promise.reject(Error("Synthetic audit failure")) as any;
    return (create as any)(...args);
  });
  try { expect((await save(f, input, key)).statusCode).toBe(500); } finally { audit.mockRestore(); }
  await emptySale(f);
  expect((await save(f, input, key)).statusCode).toBe(201);
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(1);
});

it("requires both grants, the owned branch and a full explicitly confirmed payment before any issue", async () => {
  const f = await fixture(), input = await confirmed(f);
  expect((await save(f, input)).statusCode).toBe(403); await emptySale(f);
  const cashier = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), valid = await confirmed(cashier);
  for (const payment of [{ ...valid.payment, manualConfirmed: false }, { ...valid.payment, locationId: f.locationId }, { ...valid.payment, expectedPaymentRevision: 1 }, { ...valid.payment, entries: [{ ...valid.payment.entries[0], amountPaise: 1000 }] }]) {
    expect((await save(cashier, { ...valid, payment })).statusCode).toBe(400);
  }
  const foreign = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]);
  expect((await save(foreign, valid)).statusCode).toBe(404); await emptySale(cashier); await emptySale(foreign);
});

it("does not collect stale quotes and serializes concurrent same-key retries into one paid invoice", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), stale = await confirmed(f), key = crypto.randomUUID();
  await Medicine.updateOne({ _id: f.medicine.id }, { $inc: { stockRevision: 1 } });
  expect((await save(f, stale, key)).statusCode).toBe(409); await emptySale(f);
  const input = await confirmed(f), replies = await Promise.all([save(f, input, key), save(f, input, key)]);
  expect(replies.map(reply => reply.statusCode)).toEqual([201, 201]);
  expect(replies[0].json().data.invoiceId).toBe(replies[1].json().data.invoiceId);
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(1);
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(1);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
});

function currentInput(f: Fixture, quantity = 2) {
  return { locationId: f.locationId, confirmationMode: "current_total", includeDocument: true, expectedTotalPaise: quantity * 1000,
    invoiceDiscountPaise: 0, roundOffPaise: 0,
    lines: [{ lineId: crypto.randomUUID(), medicineId: f.medicine.id, quantity, expectedUnitVersion: 1, expectedLineTotalPaise: quantity * 1000, discountPaise: 0 }],
    payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: quantity * 1000, manualConfirmed: true, cashTenderedPaise: quantity * 1000 + 500,
      entries: [{ componentId: crypto.randomUUID(), amountPaise: quantity * 1000, paymentMethod: "cash" }] } };
}

it("saves current stock and a print-ready document in one command without a quote, with identical replay and read evidence", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_VIEW_SALES"]), input = currentInput(f), key = crypto.randomUUID();
  await Medicine.updateOne({ _id: f.medicine.id }, { $inc: { stockRevision: 1 } });
  const started = performance.now(), saved = await save(f, input, key);
  expect(saved.statusCode, saved.body).toBe(201);
  expect(saved.headers["server-timing"]).toMatch(/^counter_save;dur=\d+(\.\d+)?, /);
  for (const phase of ["authority", "readiness", "prepare", "stock", "documents", "payment", "finalize", "command"]) expect(saved.headers["server-timing"]).toContain(`counter_${phase};dur=`);
  const result = saved.json().data;
  expect(result.document).toMatchObject({ id: result.invoiceId, kind: "pharmacy", status: "paid", amountPaid: 20, balanceDue: 0, paymentRevision: 1, totalAmount: 20, items: [{ quantity: 2, batches: [{ batchNumber: "ACTUAL-BATCH", sellingPricePaise: 1000 }] }] });
  const read = await app.inject({ method: "GET", url: `/api/pharmacy/invoices/${result.invoiceId}?locationId=${f.locationId}`, headers: f.headers });
  expect(read.statusCode, read.body).toBe(200); expect(read.json().data).toEqual(result.document);
  expect((await save(f, input, key)).json().data).toEqual({ ...result, replayed: true });
  const recovered = await app.inject({ method: "GET", url: `/api/pharmacy/sale-operations/${key}?locationId=${f.locationId}`, headers: f.headers });
  expect(recovered.json().data.document).toEqual(result.document);
  console.info(JSON.stringify({ probe: "local-current-total-save", elapsedMs: Math.round(performance.now() - started), serverTiming: saved.headers["server-timing"], lines: 1 }));
});

it.each(["line", "total"])("rejects a changed %s amount before stock, payment or invoice writes", async field => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), input = currentInput(f);
  if (field === "line") input.lines[0].expectedLineTotalPaise = 1900;
  else { input.expectedTotalPaise = 1900; input.payment.expectedBalancePaise = 1900; input.payment.entries[0].amountPaise = 1900; }
  const rejected = await save(f, input);
  expect(rejected.statusCode, rejected.body).toBe(409); expect(rejected.json().details.code).toBe("COUNTER_TOTAL_CHANGED");
  await emptySale(f);
});

it("keeps current-total unit, authorization and stock boundaries and does not oversell competing bills", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), invalid = currentInput(f);
  invalid.lines[0].expectedUnitVersion = 2;
  expect((await save(f, invalid)).statusCode).toBe(409); await emptySale(f);
  expect((await save(f, { ...currentInput(f), expectedProfileRevision: 1 })).statusCode).toBe(400);
  const outcomes = await Promise.all([save(f, currentInput(f, 8)), save(f, currentInput(f, 8))]);
  expect(outcomes.map(reply => reply.statusCode).sort()).toEqual([201, 409]);
  expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(1);
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(1);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(2);
});

it("recalculates line and invoice discounts on current stock and supports zero-value settlement", async () => {
  const f = await fixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]), input = currentInput(f);
  input.lines[0].discountPaise = 500; input.lines[0].expectedLineTotalPaise = 1500; input.invoiceDiscountPaise = 100;
  input.expectedTotalPaise = 1400; input.payment.expectedBalancePaise = 1400; input.payment.entries[0].amountPaise = 1400;
  const saved = await save(f, input); expect(saved.statusCode, saved.body).toBe(201);
  expect(saved.json().data.document).toMatchObject({ totalAmount: 14, amountPaid: 14, discount: 6, calculation: { totals: { lineDiscountPaise: 500, invoiceDiscountPaise: 100 } } });
  const zero = currentInput(f, 1), { payment: _payment, ...free } = zero;
  free.lines[0].discountPaise = 1000; free.lines[0].expectedLineTotalPaise = 0; free.expectedTotalPaise = 0;
  const cleared = await save(f, free); expect(cleared.statusCode, cleared.body).toBe(201);
  expect(cleared.json().data).toMatchObject({ totalPaise: 0, status: "paid", document: { balanceDue: 0 } });
  expect(await InvoiceCollectionReceipt.countDocuments({ organizationId: f.organizationId })).toBe(1);
});

it("keeps the recorded customer's revision for current-total credit and rejects payment without permission", async () => {
  const f = await fixture(), input = currentInput(f);
  expect((await save(f, input)).statusCode).toBe(403); await emptySale(f);
  const party = await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Counter customer", normalizedName: "counter customer", address: "Actual address", kinds: ["customer"], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
  const { payment: _payment, ...unpaid } = input;
  const credit = { ...unpaid, customerId: party.id, expectedCustomerRevision: 1 };
  expect((await save(f, credit)).statusCode).toBe(409);
  const saved = await save(f, { ...credit, expectedCustomerRevision: 0 }); expect(saved.statusCode, saved.body).toBe(201);
  expect(saved.json().data).toMatchObject({ status: "unpaid", document: { customerSnapshot: { partyId: party.id, name: party.name }, balanceDue: 20 } });
});

import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyPurchaseFixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { Medicine } from "../models/Medicine.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";
import { CashierShift } from "../models/CashierShift.ts";
const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Auth = { headers: Record<string, string>; locationId: string };
const post = (f: Auth, path: string, payload: object, reference = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": reference }, payload });
const get = (f: Auth, path: string) => app.inject({ method: "GET", url: `/api/pharmacy/${path}?locationId=${f.locationId}`, headers: f.headers });
async function supplierFixture() {
  const f = await pharmacyPurchaseFixture(["PHARMACY_PURCHASE", "PHARMACY_RECEIVE_STOCK", "PHARMACY_RETURN", "PHARMACY_APPROVE_REFUND"]), purchaseId = f.purchase.id;
  expect((await post(f, `purchases/${purchaseId}/post`, { locationId: f.locationId, expectedRevision: 0, expectedSupplierRevision: 0, supplierStateCode: "27", taxMode: "sgst", costTreatment: "exclude_tax", roundOffPaise: 0, reviewReference: "Synthetic actual source review" })).statusCode).toBe(200);
  expect((await post(f, `purchases/${purchaseId}/receipts`, { locationId: f.locationId, expectedRevision: 1, deliveryReference: key(), lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: 3, freeBaseUnits: 1, batchNumber: "ACTUAL", expiry: { precision: "month", value: "2099-12" } }] })).statusCode).toBe(201);
  return { ...f, purchaseId, supplierId: f.party.id as string };
}
type Supplier = Awaited<ReturnType<typeof supplierFixture>>;
async function supplierReturn(f: Supplier) {
  const source = (await get(f, `purchases/${f.purchaseId}/return-source`)).json().data.lines[0], q = await post(f, `purchases/${f.purchaseId}/returns/quote`, { locationId: f.locationId, reason: "Actual returned supplier goods", reviewReference: "Actual supplier return review", lines: [{ receiptId: source.receiptId, receiptLineId: source.receiptLineId, quantity: 2 }] }); expect(q.statusCode, q.body).toBe(200);
  const returned = await post(f, `purchases/${f.purchaseId}/returns`, q.json().data.issueInput); expect(returned.statusCode, returned.body).toBe(201); return returned.json().data;
}
const money = (f: Supplier, amountPaise: number, expectedSettlementRevision: number, fields = {}) => ({ locationId: f.locationId, supplierId: f.supplierId, amountPaise, paymentMethod: "bank", referenceNumber: key(), reviewReference: "Actual confirmed supplier movement", manualConfirmed: true, allocations: [{ purchaseId: f.purchaseId, amountPaise, expectedSettlementRevision }], ...fields });
const credit = (f: Supplier, returnId: string, amountPaise: number, expectedSettlementRevision: number, fields = {}) => ({ ...money(f, amountPaise, expectedSettlementRevision), paymentMethod: "none", sourceDate: "2026-10-20", allocations: [{ purchaseReturnId: returnId, amountPaise, expectedSettlementRevision }], ...fields });
async function statement(f: Supplier) { const response = await get(f, `suppliers/${f.supplierId}/statement`); expect(response.statusCode, response.body).toBe(200); return response.json().data; }
async function customerFixture() {
  const f = await pharmacyRetailFixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_RETURN", "PHARMACY_APPROVE_REFUND"]);
  const sale = await post(f, "sales", f.input); expect(sale.statusCode, sale.body).toBe(201); const invoiceId = sale.json().data.invoiceId as string;
  expect((await post(f, `invoices/${invoiceId}/collections`, { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 2000, entries: [{ componentId: key(), amountPaise: 2000, paymentMethod: "cash" }] })).statusCode).toBe(201);
  const source = (await get(f, `invoices/${invoiceId}/return-source`)).json().data.lines[0], q = await post(f, `invoices/${invoiceId}/returns/quote`, { locationId: f.locationId, reason: "Actual customer return", reviewReference: "Actual return review", confirmedQuarantine: true, lines: [{ sourceLineId: source.sourceLineId, sourceBatchId: source.sourceBatchId, quantity: 1, condition: "unopened" }] }); expect(q.statusCode, q.body).toBe(200); expect((await post(f, `invoices/${invoiceId}/returns`, q.json().data.issueInput)).statusCode).toBe(201);
  return { ...f, invoiceId };
}
type Customer = Awaited<ReturnType<typeof customerFixture>>;
async function refund(f: Customer, amountPaise = 1000, fields = {}, reference = key()) {
  const source = (await get(f, `invoices/${f.invoiceId}/refund-source`)).json().data;
  return post(f, "settlements/customer-refund", { locationId: f.locationId, invoiceId: f.invoiceId, amountPaise, paymentMethod: "cash", referenceNumber: key(), reviewReference: "Actual payout confirmation", manualConfirmed: true, expectedPaymentRevision: source.paymentRevision, expectedRefundPayablePaise: source.refundPayablePaise, ...fields }, reference);
}
describe("Actual supplier credits/payments/refunds and customer payout events", () => {
  it("keeps pending credit out of cash, pays post-close refunds from a new drawer, and retains the original close", async () => {
    const f = await customerFixture(); await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $addToSet: { permissions: "PHARMACY_CLOSE_TILL" } });
    const original = (await CashierShift.findOne({ organizationId: f.organizationId, locationId: f.locationId, kind: "drawer", status: "active" }))!;
    const first = await post(f, `till/${original.id}/close`, { locationId: f.locationId, expectedRevision: 1, countedCashPaise: 102000 }); expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data.drawer.drawerTotals).toMatchObject({ expectedCashPaise: 102000, eventCount: 0, incoming: { cash: 2000 } });
    expect((await refund(f, 1000)).statusCode).toBe(428); expect((await Invoice.findById(f.invoiceId))!.refundedPaise).toBe(0);
    const next = await post(f, "till/open", { locationId: f.locationId, drawerCode: "SYNTHETIC-1", openingFloatPaise: 1000 }); expect(next.statusCode, next.body).toBe(201); const drawer = next.json().data.drawer;
    const paid = await refund(f, 1000); expect(paid.statusCode, paid.body).toBe(201); expect(paid.json().data.shiftId).toBe(drawer.id);
    const closed = await post(f, `till/${drawer.id}/close`, { locationId: f.locationId, expectedRevision: 1, countedCashPaise: 0 }); expect(closed.statusCode, closed.body).toBe(201); expect(closed.json().data.drawer.drawerTotals).toMatchObject({ expectedCashPaise: 0, outgoing: { cash: 1000 }, eventCount: 1 });
    const stored = await get(f, `till/${original.id}`); expect(stored.statusCode, stored.body).toBe(200); expect(stored.json().data.drawerTotals).toEqual(first.json().data.drawer.drawerTotals); expect(stored.json().data.evidenceHash).toBe(first.json().data.drawer.evidenceHash);
  });
  it("records actual supplier payment once, freezes its evidence and leaves stock and original payable unchanged", async () => {
    const f = await supplierFixture(), input = money(f, 118, 0), reference = key(), response = await post(f, "settlements/supplier-payment", input, reference); expect(response.statusCode, response.body).toBe(201); const event = response.json().data;
    expect((await post(f, "settlements/supplier-payment", input, reference)).json().data.eventId).toBe(event.eventId); expect((await statement(f)).totals).toMatchObject({ payablePaise: 118, paidPaise: 118, duePaise: 0 }); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4); expect((await PharmacyPurchase.findById(f.purchaseId))!.posting!.payablePaise).toBe(118);
    await expect(PharmacyCashEvent.updateOne({ _id: event.eventId }, { $set: { amountPaise: 1 } })).rejects.toThrow(/append-only/); expect((await post(f, "settlements/supplier-payment", money(f, 1, 1))).statusCode).toBe(409);
    expect((await get(f, `cash-operations/${reference}`)).json().data).toMatchObject({ eventId: event.eventId, amountPaise: 118 });
  });
  it("keeps expected supplier credits pending until actual note allocations arrive, including partial notes", async () => {
    const f = await supplierFixture(), returned = await supplierReturn(f); expect((await statement(f)).totals).toMatchObject({ pendingCreditPaise: 59, confirmedCreditPaise: 0, duePaise: 118 });
    expect((await post(f, "settlements/supplier-payment", money(f, 20, 1))).statusCode).toBe(201); const first = await post(f, "settlements/supplier-credit", credit(f, returned.returnId, 30, 2)); expect(first.statusCode, first.body).toBe(201); expect((await statement(f)).totals).toMatchObject({ confirmedCreditPaise: 30, pendingCreditPaise: 29, paidPaise: 20, duePaise: 68 });
    expect((await post(f, "settlements/supplier-credit", credit(f, returned.returnId, 29, 3))).statusCode).toBe(201); expect((await statement(f)).totals).toMatchObject({ confirmedCreditPaise: 59, pendingCreditPaise: 0, duePaise: 39 }); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(2);
  });
  it("caps supplier note allocations and rejects duplicate actual note identity under a different operation key", async () => {
    const f = await supplierFixture(), returned = await supplierReturn(f); expect((await post(f, "settlements/supplier-credit", credit(f, returned.returnId, 60, 1))).statusCode).toBe(409);
    const note = "Actual-Note-001"; expect((await post(f, "settlements/supplier-credit", credit(f, returned.returnId, 29, 1, { referenceNumber: note }))).statusCode).toBe(201);
    expect((await post(f, "settlements/supplier-credit", credit(f, returned.returnId, 30, 2, { referenceNumber: "actual-note-001" }))).statusCode).toBe(409); expect((await statement(f)).totals.pendingCreditPaise).toBe(30); expect((await PharmacyPurchase.findById(f.purchaseId))!.settlementRevision).toBe(2);
  });
  it("records supplier refund received only against an actual overpaid/credited source", async () => {
    const f = await supplierFixture(); expect((await post(f, "settlements/supplier-payment", money(f, 118, 0))).statusCode).toBe(201); const returned = await supplierReturn(f); expect((await post(f, "settlements/supplier-credit", credit(f, returned.returnId, 59, 2))).statusCode).toBe(201);
    expect((await statement(f)).totals.supplierRefundReceivablePaise).toBe(59); const received = await post(f, "settlements/supplier-refund", money(f, 59, 3)); expect(received.statusCode, received.body).toBe(201); expect((await statement(f)).totals).toMatchObject({ supplierRefundReceivablePaise: 0, duePaise: 0, supplierRefundedPaise: 59 }); expect((await post(f, "settlements/supplier-refund", money(f, 1, 4))).statusCode).toBe(409);
  });
  it("serializes different-key supplier payments and deduplicates concurrent same-key payments", async () => {
    const f = await supplierFixture(), input = money(f, 118, 0), results = await Promise.all([post(f, "settlements/supplier-payment", input), post(f, "settlements/supplier-payment", { ...input, referenceNumber: key() })]); expect(results.map(row => row.statusCode).sort()).toEqual([201, 409]); expect(await PharmacyCashEvent.countDocuments({ partyId: f.supplierId })).toBe(1);
    const other = await supplierFixture(), same = money(other, 118, 0), reference = key(), repeated = await Promise.all([post(other, "settlements/supplier-payment", same, reference), post(other, "settlements/supplier-payment", same, reference)]); expect(repeated.map(row => row.statusCode)).toEqual([201, 201]); expect(repeated[0].json().data.eventId).toBe(repeated[1].json().data.eventId);
  });
  it("pays capped partial customer refunds without rewriting original receipts and returns original replay snapshots", async () => {
    const f = await customerFixture(), movements = await StockMovement.countDocuments({ medicineId: f.medicine.id }), inputSource = (await get(f, `invoices/${f.invoiceId}/refund-source`)).json().data;
    expect(inputSource.refundPayablePaise).toBe(1000); const reference = key(), body = { locationId: f.locationId, invoiceId: f.invoiceId, amountPaise: 700, paymentMethod: "cash", referenceNumber: key(), reviewReference: "Actual payout confirmation", manualConfirmed: true, expectedPaymentRevision: inputSource.paymentRevision, expectedRefundPayablePaise: 1000 };
    const first = await post(f, "settlements/customer-refund", body, reference); expect(first.statusCode, first.body).toBe(201); expect(first.json().data.after.refundPayablePaise).toBe(300); expect((await refund(f, 300)).statusCode).toBe(201);
    expect((await post(f, "settlements/customer-refund", body, reference)).json().data.after.refundPayablePaise).toBe(300); const invoice = await Invoice.findById(f.invoiceId); expect(invoice).toMatchObject({ totalAmount: 20, amountPaid: 20, creditedPaise: 1000, refundedPaise: 1000, payments: [{ amount: 20 }] }); expect((await refund(f, 1)).statusCode).toBe(409); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(movements);
  });
  it("rolls back customer payout projection and event on required audit failure", async () => {
    const f = await customerFixture(), create = AuditLog.create.bind(AuditLog), spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_SETTLEMENT_RECORDED") throw new Error("Synthetic required audit failure"); return (create as any)(docs, ...args); }) as any);
    try { expect((await refund(f)).statusCode).toBe(500); } finally { spy.mockRestore(); } expect((await Invoice.findById(f.invoiceId))!.refundedPaise).toBe(0); expect(await PharmacyCashEvent.countDocuments({ invoiceId: f.invoiceId })).toBe(0); expect((await get(f, `invoices/${f.invoiceId}/refund-source`)).json().data.refundPayablePaise).toBe(1000);
  });
  it("keeps only the newly remaining refund payable after a later return follows a partial payout", async () => {
    const f = await customerFixture(); expect((await refund(f, 700)).statusCode).toBe(201);
    const source = (await get(f, `invoices/${f.invoiceId}/return-source`)).json().data.lines[0], q = await post(f, `invoices/${f.invoiceId}/returns/quote`, { locationId: f.locationId, reason: "Remaining actual goods returned", reviewReference: "Actual further source review", confirmedQuarantine: true, lines: [{ sourceLineId: source.sourceLineId, sourceBatchId: source.sourceBatchId, quantity: 1, condition: "unopened" }] }); expect(q.statusCode, q.body).toBe(200);
    const returned = await post(f, `invoices/${f.invoiceId}/returns`, q.json().data.issueInput); expect(returned.statusCode, returned.body).toBe(201); expect(returned.json().data.refundPayablePaise).toBe(1300); expect((await get(f, `invoices/${f.invoiceId}/refund-source`)).json().data).toMatchObject({ refundPayablePaise: 1300, refundedPaise: 700, creditedPaise: 2000 }); expect((await refund(f, 1300)).statusCode).toBe(201); expect((await refund(f, 1)).statusCode).toBe(409);
  });
  it("requires actual financial authority and source-scope access, with continuity after disable", async () => {
    const f = await supplierFixture(), foreign = await supplierFixture(); expect((await get(f, `suppliers/${foreign.supplierId}/statement`)).statusCode).toBe(404);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_PURCHASE"] } }); expect((await post(f, "settlements/supplier-payment", money(f, 1, 0))).statusCode).toBe(403);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_APPROVE_REFUND"] } }); expect((await post(f, "settlements/supplier-payment", money(f, 1, 0))).statusCode).toBe(403);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_PURCHASE", "PHARMACY_APPROVE_REFUND"] } }); await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: false, revision: 1, updatedBy: f.user.id, updatedAt: new Date(), reviewReference: "Synthetic disable" } } }); const paid = await post(f, "settlements/supplier-payment", money(f, 1, 0)); expect(paid.statusCode, paid.body).toBe(201);
  });
  it("rejects false/manual coercion, zero/invalid amounts, fake methods/dates and unsupported command kinds", async () => {
    const f = await supplierFixture();
    for (const extra of [{ manualConfirmed: false }, { manualConfirmed: "true" }, { amountPaise: 0 }, { amountPaise: "118" }, { amountPaise: -1 }, { paymentMethod: "qr_displayed" }, { paidAt: "2026-10-20" }, { shiftId: key() }, { amountPaise: 119 }]) { const response = await post(f, "settlements/supplier-payment", money(f, 118, 0, extra)); expect(response.statusCode, response.body).toBe(400); }
    expect((await post(f, "settlements/toString", money(f, 118, 0))).statusCode).toBe(400); expect(await PharmacyCashEvent.countDocuments({ partyId: f.supplierId })).toBe(0);
  });
});

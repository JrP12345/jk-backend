import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { Invoice } from "../models/Invoice.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyReturn } from "../models/PharmacyReturn.ts";
import { InvoiceCreditNote } from "../models/InvoiceCreditNote.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";
import { collectTillReceipts } from "../services/TillCollectionService.ts";
import { allocateSourceCredit, cumulativeSourceCredit } from "../services/InvoiceCalculationService.ts";
const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
async function fixture(permissions = ["PHARMACY_SELL", "PHARMACY_RETURN", "PHARMACY_APPROVE_REFUND", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_ADJUST_STOCK"]) {
  const f = await pharmacyRetailFixture(permissions), sale = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key() }, payload: f.input }); expect(sale.statusCode, sale.body).toBe(201);
  const invoiceId = sale.json().data.invoiceId as string;
  return { ...f, invoiceId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const get = (f: Fixture, path = `invoices/${f.invoiceId}/return-source`) => app.inject({ method: "GET", url: `/api/pharmacy/${path}?locationId=${f.locationId}`, headers: f.headers });
const post = (f: Fixture, input: object, reference = key(), suffix = "") => app.inject({ method: "POST", url: `/api/pharmacy/invoices/${f.invoiceId}/returns${suffix}`, headers: { ...f.headers, "idempotency-key": reference }, payload: input });
async function intent(f: Fixture, quantity = 1) { const source = await get(f); expect(source.statusCode, source.body).toBe(200); const row = source.json().data.lines[0]; return { locationId: f.locationId, reason: "Actual returned goods", reviewReference: "Synthetic operator approval reference", confirmedQuarantine: true, lines: [{ sourceLineId: row.sourceLineId, sourceBatchId: row.sourceBatchId, quantity, condition: "unopened" }] }; }
async function review(f: Fixture, quantity = 1) { const response = await post(f, await intent(f, quantity), key(), "/quote"); expect(response.statusCode, response.body).toBe(200); return response.json().data; }
async function collect(f: Fixture, amount = 2000) { const invoice = await Invoice.findById(f.invoiceId); const response = await app.inject({ method: "POST", url: `/api/pharmacy/invoices/${f.invoiceId}/collections`, headers: { ...f.headers, "idempotency-key": key() }, payload: { locationId: f.locationId, expectedPaymentRevision: invoice!.paymentRevision, expectedBalancePaise: Math.round(invoice!.balanceDue! * 100), manualConfirmed: true, cashTenderedPaise: amount, entries: [{ componentId: key(), paymentMethod: "cash", amountPaise: amount }] } }); expect(response.statusCode, response.body).toBe(201); return response.json().data; }
describe("Source-bound pharmacy returns, credits and physical quarantine", () => {
  it("commits source credit and quarantined owned lots once, preserving original bill, prices and rational cost", async () => {
    const f = await fixture(), original = (await Invoice.findById(f.invoiceId))!.toObject(), q = await review(f), reference = key();
    expect(q.totals.payablePaise).toBe(1000); expect(await PharmacyReturn.countDocuments({ invoiceId: f.invoiceId })).toBe(0);
    const response = await post(f, q.issueInput, reference); expect(response.statusCode, response.body).toBe(201); const result = response.json().data;
    expect(result).toMatchObject({ creditedPaise: 1000, totalCreditedPaise: 1000, balancePaise: 1000, refundPayablePaise: 0, disposition: "quarantined", revision: 1 });
    expect((await post(f, q.issueInput, reference)).json().data.returnId).toBe(result.returnId); expect((await post(f, { ...q.issueInput, reason: "Different returned goods" }, reference)).statusCode).toBe(409); const saved = await Invoice.findById(f.invoiceId);
    expect(saved).toMatchObject({ totalAmount: original.totalAmount, items: original.items, taxDocument: original.taxDocument, creditedPaise: 1000, balanceDue: 10, amountPaid: 0, paymentRevision: 1 });
    const returned = await MedicineBatch.findOne({ "returnSource.returnId": result.returnId }); expect(returned).toMatchObject({ quantity: 1, receivedQuantity: 1, status: "quarantined", costBasis: { totalPaise: 101, receivedBaseUnits: 10 } }); expect(returned!.purchaseCost).toBe(101 / 10 / 100);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(9); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, disposition: "quarantine_return" })).toBe(1);
    expect((await get(f)).json().data.lines[0]).toMatchObject({ soldQuantity: 2, returnedQuantity: 1, remainingQuantity: 1 });
    expect((await get(f, `returns/${result.returnId}`)).json().data.creditNote).toMatchObject({ payablePaise: 1000, policy: "source-credit-paise-v1", taxAdjustment: "professional_review_required" });
    await expect(PharmacyReturn.updateOne({ _id: result.returnId }, { $set: { reason: "changed" } })).rejects.toThrow(/append-only/); await expect(InvoiceCreditNote.deleteOne({ _id: result.creditNoteId })).rejects.toThrow(/append-only/);
  });
  it("prevents a cumulative over-return with different keys and refreshes remaining quantity", async () => {
    const f = await fixture(), q = await review(f, 2), responses = await Promise.all([post(f, q.issueInput), post(f, q.issueInput)]);
    expect(responses.map(row => row.statusCode).sort()).toEqual([201, 409]); expect(await PharmacyReturn.countDocuments({ invoiceId: f.invoiceId })).toBe(1); expect((await get(f)).json().data.lines[0].remainingQuantity).toBe(0);
    expect((await post(f, await intent(f), key(), "/quote")).statusCode).toBe(409); const till = await collectTillReceipts(f.organizationId, f.locationId); expect(till.systemTotals.total).toBe(0); expect(till.reconciliation.requiresReview).toBe(false);
  });
  it("does not sell returned quarantine or release it through count correction", async () => {
    const f = await fixture(), q = await review(f, 2), result = (await post(f, q.issueInput)).json().data;
    const medicine = await Medicine.findById(f.medicine.id), saleInput = { ...f.input, expectedTotalPaise: 10000, lines: [{ ...f.input.lines[0], quantity: 10, expectedStockRevision: medicine!.stockRevision }] };
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key() }, payload: saleInput })).statusCode).toBe(409);
    const batch = await MedicineBatch.findOne({ "returnSource.returnId": result.returnId }); const adjusted = await app.inject({ method: "POST", url: "/api/pharmacy/adjust-stock", headers: f.headers, payload: { medicineId: f.medicine.id, locationId: f.locationId, batchId: batch!.id, newQuantity: 3, expectedQuantity: 2, expectedRevision: medicine!.stockRevision, clientRequestId: key(), reason: "physical_audit" } }); expect(adjusted.statusCode).toBe(409); expect((await MedicineBatch.findById(batch!.id))!.status).toBe("quarantined");
  });
  it("separates a credit from a confirmed refund and retains original receipt/till evidence", async () => {
    const f = await fixture(), receipt = await collect(f), q = await review(f), response = await post(f, q.issueInput); expect(response.statusCode, response.body).toBe(201);
    expect(response.json().data).toMatchObject({ balancePaise: 0, refundPayablePaise: 1000 }); const invoice = await Invoice.findById(f.invoiceId); expect(invoice).toMatchObject({ amountPaid: 20, totalAmount: 20, creditedPaise: 1000, status: "paid", payments: [{ amount: 20 }] });
    const till = await collectTillReceipts(f.organizationId, f.locationId); expect(till.systemTotals.cash).toBe(20); expect(till.reconciliation.requiresReview).toBe(false);
    expect((await get(f, `collection-operations/${receipt.requestKey}`)).json().data).toMatchObject({ paidPaise: 2000, balancePaise: 0, creditedPaise: 0 });
  });
  it("reduces an unpaid balance and collects only the exact net due with captured credit evidence", async () => {
    const f = await fixture(), q = await review(f); expect((await post(f, q.issueInput)).statusCode).toBe(201); const receipt = await collect(f, 1000); expect(receipt).toMatchObject({ collectedPaise: 1000, paidPaise: 1000, balancePaise: 0, creditedPaise: 1000 });
  });
  it("rejects a stale return review after collection and rolls back every effect on required audit failure", async () => {
    const f = await fixture(), q = await review(f); await collect(f); expect((await post(f, q.issueInput)).statusCode).toBe(409);
    const next = await review(f), create = AuditLog.create.bind(AuditLog), spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_SALES_RETURN") throw new Error("Synthetic required audit failure"); return (create as any)(docs, ...args); }) as any);
    try { expect((await post(f, next.issueInput)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect(await PharmacyReturn.countDocuments({ invoiceId: f.invoiceId })).toBe(0); expect(await InvoiceCreditNote.countDocuments({ invoiceId: f.invoiceId })).toBe(0); expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id, receiptKind: "return" })).toBe(0); expect((await Invoice.findById(f.invoiceId))!.creditedPaise).toBe(0); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });
  it("requires independent return and financial approval grants, and current grants on replay", async () => {
    const f = await fixture(["PHARMACY_SELL", "PHARMACY_RETURN"]), q = await review(f); expect((await post(f, q.issueInput)).statusCode).toBe(403);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_SELL", "PHARMACY_RETURN", "PHARMACY_APPROVE_REFUND"] } }); const reference = key(), posted = await post(f, q.issueInput, reference); expect(posted.statusCode, posted.body).toBe(201);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_SELL"] } }); expect((await post(f, q.issueInput, reference)).statusCode).toBe(403); expect((await get(f, `return-operations/${reference}`)).statusCode).toBe(200);
  });
  it("keeps continuity returns/history available after pharmacy disable and excludes foreign invoice/lot evidence", async () => {
    const f = await fixture(), foreign = await fixture(), input = await intent(f), q = await review(f); await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: false, revision: 1, updatedBy: f.user.id, updatedAt: new Date(), reviewReference: "Synthetic disable" } } });
    const reference = key(), result = await post(f, q.issueInput, reference); expect(result.statusCode, result.body).toBe(201); expect((await get(f, `return-operations/${reference}`)).statusCode).toBe(200);
    expect((await get(f, `invoices/${foreign.invoiceId}/return-source`)).statusCode).toBe(404); expect((await post(f, { ...input, lines: [{ ...input.lines[0], sourceBatchId: (await MedicineBatch.findOne({ medicineId: foreign.medicine.id }))!.id }] }, key(), "/quote")).statusCode).toBe(409);
  });
  it.each([{ confirmedQuarantine: false }, { actorId: "forged" }, { disposition: "saleable" }, { expectedCreditPaise: 1 }, { lines: [] }])("rejects invalid physical/financial authority or intent %j", async extra => {
    const f = await fixture(); expect((await post(f, { ...await intent(f), ...extra }, key(), "/quote")).statusCode).toBe(400);
  });
  it("allocates odd paise, discounts, different lot prices and explicit round-off cumulatively without exceeding any captured component", () => {
    const basis = allocateSourceCredit([{ lineId: "line", quantity: 3, baseAmountPaise: 91, cgstPaise: 2, sgstPaise: 3, lots: [{ batchId: "a", quantity: 2, unitPricePaise: 30 }, { batchId: "b", quantity: 1, unitPricePaise: 50 }] }], 95);
    const credits = basis.flatMap(lot => Array.from({ length: lot.quantity }, (_, index) => cumulativeSourceCredit(lot, index, 1)));
    expect(credits.reduce((sum, row) => sum + row.payablePaise, 0)).toBe(95); expect(credits.reduce((sum, row) => sum + row.baseAmountPaise, 0)).toBe(91); expect(credits.reduce((sum, row) => sum + row.cgstPaise, 0)).toBe(2); expect(credits.reduce((sum, row) => sum + row.sgstPaise, 0)).toBe(3); expect(credits.reduce((sum, row) => sum + row.roundOffPaise, 0)).toBe(-1);
    expect(() => cumulativeSourceCredit(basis[0], 2, 1)).toThrow(/exceeds/);
    const free = allocateSourceCredit([{ lineId: "free", quantity: 2, baseAmountPaise: 0, cgstPaise: 0, sgstPaise: 0, lots: [{ batchId: "a", quantity: 2, unitPricePaise: 0 }] }], 1);
    expect(cumulativeSourceCredit(free[0], 0, 2).payablePaise).toBe(1);
  });
});

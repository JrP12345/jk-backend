import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyPurchaseFixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyPurchaseReturn } from "../models/PharmacyPurchaseReturn.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";
const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
const post = (f: { headers: object }, path: string, payload: object, reference = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": reference }, payload });
async function fixture() {
  const f = await pharmacyPurchaseFixture(["PHARMACY_PURCHASE", "PHARMACY_RECEIVE_STOCK", "PHARMACY_RETURN"]), purchaseId = f.purchase.id;
  const posting = await post(f, `purchases/${purchaseId}/post`, { locationId: f.locationId, expectedRevision: 0, expectedSupplierRevision: 0, supplierStateCode: "27", taxMode: "sgst", costTreatment: "exclude_tax", roundOffPaise: 0, reviewReference: "Synthetic source review" }); expect(posting.statusCode, posting.body).toBe(200);
  const received = await post(f, `purchases/${purchaseId}/receipts`, { locationId: f.locationId, expectedRevision: 1, deliveryReference: key(), lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: 3, freeBaseUnits: 1, batchNumber: "ACTUAL-RECEIVED", expiry: { precision: "month", value: "2099-12" } }] }); expect(received.statusCode, received.body).toBe(201);
  return { ...f, purchaseId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const read = (f: Fixture, purchaseId = f.purchaseId) => app.inject({ method: "GET", url: `/api/pharmacy/purchases/${purchaseId}/return-source?locationId=${f.locationId}`, headers: f.headers });
async function review(f: Fixture, quantity = 2) { const source = await read(f); expect(source.statusCode, source.body).toBe(200); const row = source.json().data.lines[0]; const response = await post(f, `purchases/${f.purchaseId}/returns/quote`, { locationId: f.locationId, reason: "Actual goods returned to supplier", reviewReference: "Actual supplier-return review", lines: [{ receiptId: row.receiptId, receiptLineId: row.receiptLineId, quantity }] }); expect(response.statusCode, response.body).toBe(200); return response.json().data; }
describe("Source-receipt purchase returns before actual supplier credit", () => {
  it("deducts original received stock once and tracks an expected credit without changing the posted payable", async () => {
    const f = await fixture(), q = await review(f), reference = key(); expect(q.expectedCreditPaise).toBe(59); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
    const response = await post(f, `purchases/${f.purchaseId}/returns`, q.issueInput, reference); expect(response.statusCode, response.body).toBe(201); const result = response.json().data;
    expect(result).toMatchObject({ expectedCreditPaise: 59, supplierCreditConfirmed: false, settlementRevision: 1 }); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(2); expect((await MedicineBatch.findOne({ medicineId: f.medicine.id }))!.quantity).toBe(2);
    expect((await PharmacyPurchase.findById(f.purchaseId))!.posting!.payablePaise).toBe(118); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, disposition: "supplier_return" })).toBe(1);
    expect((await post(f, `purchases/${f.purchaseId}/returns`, q.issueInput, reference)).json().data.returnId).toBe(result.returnId);
    expect((await post(f, `purchases/${f.purchaseId}/returns`, { ...q.issueInput, reason: "changed source" }, reference)).statusCode).toBe(409);
    const recovered = await app.inject({ method: "GET", url: `/api/pharmacy/purchase-return-operations/${reference}?locationId=${f.locationId}`, headers: f.headers }); expect(recovered.json().data.returnId).toBe(result.returnId);
    await expect(PharmacyPurchaseReturn.updateOne({ _id: result.returnId }, { $set: { expectedCreditPaise: 1 } })).rejects.toThrow(/append-only/);
  });
  it("caps concurrent/different-key returns by on-hand and original received quantities", async () => {
    const f = await fixture(), q = await review(f, 4), results = await Promise.all([post(f, `purchases/${f.purchaseId}/returns`, q.issueInput), post(f, `purchases/${f.purchaseId}/returns`, q.issueInput)]); expect(results.map(row => row.statusCode).sort()).toEqual([201, 409]); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); expect(await PharmacyPurchaseReturn.countDocuments({ purchaseId: f.purchaseId })).toBe(1); expect((await read(f)).json().data.lines[0]).toMatchObject({ returnedQuantity: 4, remainingQuantity: 0 });
  });
  it("allocates the final odd paise through repeated partial supplier returns", async () => {
    const f = await fixture(); let total = 0; for (let n = 0; n < 4; n++) { const q = await review(f, 1), response = await post(f, `purchases/${f.purchaseId}/returns`, q.issueInput); expect(response.statusCode, response.body).toBe(201); total += response.json().data.expectedCreditPaise; } expect(total).toBe(118);
  });
  it("rejects a stale stock review and rolls back physical changes on required audit failure", async () => {
    const f = await fixture(), q = await review(f); expect((await post(f, `purchases/${f.purchaseId}/returns`, { ...q.issueInput, lines: [{ ...q.issueInput.lines[0], expectedStockRevision: 99 }] })).statusCode).toBe(409);
    const create = AuditLog.create.bind(AuditLog), spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_PURCHASE_RETURN") throw new Error("Synthetic required audit failure"); return (create as any)(docs, ...args); }) as any);
    try { expect((await post(f, `purchases/${f.purchaseId}/returns`, q.issueInput)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4); expect((await MedicineBatch.findOne({ medicineId: f.medicine.id }))!.quantity).toBe(4); expect((await PharmacyPurchase.findById(f.purchaseId))!.settlementRevision).toBe(0); expect(await PharmacyPurchaseReturn.countDocuments({ purchaseId: f.purchaseId })).toBe(0);
  });
  it("requires current purchase and return grants while allowing corrections after pharmacy disable", async () => {
    const f = await fixture(), q = await review(f); await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_PURCHASE"] } }); expect((await post(f, `purchases/${f.purchaseId}/returns`, q.issueInput)).statusCode).toBe(403);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_PURCHASE", "PHARMACY_RETURN"] } }); await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: false, revision: 1, updatedBy: f.user.id, updatedAt: new Date(), reviewReference: "Synthetic disable" } } }); const response = await post(f, `purchases/${f.purchaseId}/returns`, q.issueInput); expect(response.statusCode, response.body).toBe(201);
  });
  it("rejects foreign purchase/receipt evidence and cannot return more than remains on hand", async () => {
    const f = await fixture(), foreign = await fixture(); expect((await read(f, foreign.purchaseId)).statusCode).toBe(404); const q = await review(f), other = (await read(foreign)).json().data.lines[0]; expect((await post(f, `purchases/${f.purchaseId}/returns`, { ...q.issueInput, lines: [{ ...q.issueInput.lines[0], receiptId: other.receiptId }] })).statusCode).toBe(409);
    const batch = await MedicineBatch.findOne({ medicineId: f.medicine.id }); await MedicineBatch.updateOne({ _id: batch!._id }, { $set: { quantity: 1 } }); await Medicine.updateOne({ _id: f.medicine.id }, { $set: { stockQuantity: 1 }, $inc: { stockRevision: 1 } }); const source = (await read(f)).json().data; expect(source.lines[0].remainingQuantity).toBe(1); expect((await post(f, `purchases/${f.purchaseId}/returns`, q.issueInput)).statusCode).toBe(409);
  });
});

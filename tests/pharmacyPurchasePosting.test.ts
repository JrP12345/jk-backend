import { pharmacyPurchaseFixture as fixture } from "./helpers/pharmacyPurchaseFixture.ts";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { Role } from "../models/Role.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyPurchaseReceipt } from "../models/PharmacyPurchaseReceipt.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";
import { dispenseMedicineFEFO } from "../services/PharmacyInventoryService.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });

type Auth = { headers: { authorization: string } };
const post = (f: Auth, path: string, body: object, requestKey = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": requestKey }, payload: body });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const posting = (f: Fixture, fields = {}) => ({ locationId: f.locationId, expectedRevision: 0, expectedSupplierRevision: 0, supplierStateCode: "27", taxMode: "sgst", costTreatment: "exclude_tax", roundOffPaise: 0, reviewReference: "Synthetic supplier/tax review; not professional approval", ...fields });
const commit = (f: Fixture, fields = {}, requestKey = key()) => post(f, `purchases/${f.purchase.id}/post`, posting(f, fields), requestKey);
const delivery = (f: Fixture, fields = {}) => ({ locationId: f.locationId, expectedRevision: 1, deliveryReference: `DELIVERY-${key()}`,
  lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: 1, freeBaseUnits: 0, batchNumber: "PRINTED-BATCH", expiry: { precision: "month", value: "2099-12" } }], ...fields });
const receive = (f: Fixture, body = delivery(f), requestKey = key()) => post(f, `purchases/${f.purchase.id}/receipts`, body, requestKey);
const recover = (f: Fixture, kind: string, requestKey: string) => app.inject({ method: "GET", url: `/api/pharmacy/purchases/${f.purchase.id}/operations/${kind}/${requestKey}?locationId=${f.locationId}`, headers: f.headers });
const read = (f: Fixture) => app.inject({ method: "GET", url: `/api/pharmacy/purchases/${f.purchase.id}?locationId=${f.locationId}`, headers: f.headers });

describe("Supplier posting and source-bound partial deliveries", () => {
  it("posts one frozen payable without stock or sales effects, with immutable operation replay", async () => {
    const f = await fixture(), requestKey = key(), first = await commit(f, {}, requestKey);
    expect(first.statusCode, first.body).toBe(200); expect(first.json().data).toMatchObject({ payablePaise: 118, revision: 1, replayed: false });
    expect((await commit(f, {}, requestKey)).json().data).toEqual({ ...first.json().data, replayed: true });
    expect((await commit(f, { expectedRevision: 1 })).statusCode).toBe(409);
    expect((await commit(f, { reviewReference: "Changed reference" }, requestKey)).statusCode).toBe(409);
    const saved = (await read(f)).json().data;
    expect(saved).toMatchObject({ status: "posted", revision: 1, posting: { payablePaise: 118, costTreatment: "exclude_tax", calculation: { taxMode: "sgst", totals: { baseAmountPaise: 100, cgstPaise: 9, sgstPaise: 9, payablePaise: 118 } } } });
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect(await AuditLog.countDocuments({ targetId: f.purchase.id, action: "PHARMACY_PURCHASE_POSTED" })).toBe(1);
    const { replayed: _replayed, ...original } = first.json().data;
    expect((await recover(f, "post", requestKey)).json().data).toEqual(original);
    await expect(PharmacyPurchase.updateOne({ _id: f.purchase.id }, { $set: { "posting.payablePaise": 1 } })).rejects.toThrow(/immutable/);
    await expect(PharmacyPurchase.findOneAndUpdate({ _id: f.purchase.id }, { $set: { lines: [] } })).rejects.toThrow(/immutable/);
    const posted = (await PharmacyPurchase.findById(f.purchase.id))!; posted.status = "draft"; await expect(posted.save()).rejects.toThrow(/immutable/);
    await expect(posted.deleteOne()).rejects.toThrow(/immutable/);
    const edit = await app.inject({ method: "PUT", url: `/api/pharmacy/purchases/${f.purchase.id}`, headers: f.headers, payload: { ...f.body, expectedRevision: 1 } }); expect(edit.statusCode).toBe(409);
  });
  it("reconciles partial billed/free receipts and cost through the final delivery without another payable", async () => {
    const f = await fixture(); expect((await commit(f)).statusCode).toBe(200);
    const requestKey = key(), body = delivery(f), first = await receive(f, body, requestKey); expect(first.statusCode, first.body).toBe(201);
    expect(first.json().data.lines[0]).toMatchObject({ billedBaseUnits: 1, freeBaseUnits: 0, costPaise: 25 });
    expect((await receive(f, body, requestKey)).json().data).toEqual({ ...first.json().data, replayed: true });
    const secondBody = delivery(f, { expectedRevision: 2 }); secondBody.lines[0].billedBaseUnits = 2; secondBody.lines[0].freeBaseUnits = 1;
    const second = await receive(f, secondBody); expect(second.statusCode, second.body).toBe(201); expect(second.json().data.lines[0].costPaise).toBe(75);
    const lots = await MedicineBatch.find({ medicineId: f.medicine.id }).sort({ receivedAt: 1, _id: 1 });
    expect(lots.map(lot => lot.costBasis!.totalPaise)).toEqual([25, 75]); expect(lots.map(lot => lot.quantity)).toEqual([1, 3]);
    expect(lots.every(lot => String(lot.purchaseSource!.purchaseId) === f.purchase.id && lot.gstRate === 18 && lot.hsnCode === "300490")).toBe(true);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, "purchaseSource.purchaseId": f.purchase.id, kind: "receipt" })).toBe(2);
    expect((await read(f)).json().data).toMatchObject({ receiptCount: 2, revision: 3, posting: { payablePaise: 118 }, receiptProgress: [{ billedBaseUnits: 3, freeBaseUnits: 1, costPaise: 100 }] });
    expect((await receive(f, delivery(f, { expectedRevision: 3 }))).statusCode).toBe(409);
    expect((await recover(f, "post", (first.json().data.requestKey))).statusCode).toBe(404);
  });
  it("allocates odd inclusive acquisition cost exactly and keeps a free-only source line free", async () => {
    const f = await fixture(); expect((await commit(f, { costTreatment: "include_tax" })).statusCode).toBe(200);
    const first = await receive(f); expect(first.statusCode, first.body).toBe(201); expect(first.json().data.lines[0].costPaise).toBe(30);
    const rest = delivery(f, { expectedRevision: 2 }); rest.lines[0].billedBaseUnits = 2; rest.lines[0].freeBaseUnits = 1;
    const response = await receive(f, rest); expect(response.statusCode, response.body).toBe(201); expect(response.json().data.lines[0].costPaise).toBe(88);
    expect((await read(f)).json().data.receiptProgress[0].costPaise).toBe(118);
    const free = await fixture(); free.body.lines[0].looseUnits = 0; free.body.lines[0].baseAmountPaise = 0; free.body.statedTotalPaise = 0;
    expect((await app.inject({ method: "PUT", url: `/api/pharmacy/purchases/${free.purchase.id}`, headers: free.headers, payload: { ...free.body, expectedRevision: 0 } })).statusCode).toBe(200);
    expect((await commit(free, { expectedRevision: 1 })).statusCode).toBe(200);
    const freeDelivery = delivery(free, { expectedRevision: 2 }); freeDelivery.lines[0].billedBaseUnits = 0; freeDelivery.lines[0].freeBaseUnits = 1;
    expect((await receive(free, freeDelivery)).json().data.lines[0].costPaise).toBe(0);
  });
  it("accepts multiple lots for a source line, including differing printed expiry, in one atomic delivery", async () => {
    const f = await fixture(); await commit(f); const body = delivery(f);
    body.lines.push({ ...body.lines[0], lineId: key(), batchNumber: "BATCH-OTHER", expiry: { precision: "day", value: "2099-11-30" } });
    const response = await receive(f, body); expect(response.statusCode, response.body).toBe(201); expect(response.json().data.lines).toHaveLength(2);
    const lots = await MedicineBatch.find({ medicineId: f.medicine.id }); expect(lots.map(lot => lot.expirySnapshot!.value).sort()).toEqual(["2099-11-30", "2099-12"]);
  });
  it("serializes concurrent posting and remaining receipts across different keys", async () => {
    const f = await fixture(), posts = await Promise.all([commit(f), commit(f)]); expect(posts.map(row => row.statusCode).sort()).toEqual([200, 409]);
    const body = delivery(f); body.lines[0].billedBaseUnits = 3; body.lines[0].freeBaseUnits = 1;
    const receipts = await Promise.all([receive(f, body), receive(f, { ...body, deliveryReference: "ANOTHER-DELIVERY" })]);
    expect(receipts.map(row => row.statusCode).sort()).toEqual([201, 409]); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
    expect(await PharmacyPurchaseReceipt.countDocuments({ purchaseId: f.purchase.id })).toBe(1);
  });
  it("replays concurrent identical receipt keys and prevents repeated deliveries even without the new delivery index", async () => {
    const f = await fixture(); await commit(f); const body = delivery(f), requestKey = key();
    const responses = await Promise.all([receive(f, body, requestKey), receive(f, body, requestKey)]); expect(responses.map(row => row.statusCode)).toEqual([201, 201]);
    expect(new Set(responses.map(row => row.json().data.receiptId)).size).toBe(1);
    const index = (await PharmacyPurchaseReceipt.collection.listIndexes().toArray()).find(row => row.unique && row.key.normalizedDeliveryReference);
    expect(index?.name).toBeTruthy(); await PharmacyPurchaseReceipt.collection.dropIndex(index!.name!);
    try {
      expect((await receive(f, { ...body, expectedRevision: 2, deliveryReference: ` ${body.deliveryReference.toLowerCase()} ` })).statusCode).toBe(409);
      const next = delivery(f, { expectedRevision: 2, deliveryReference: "DUPLICATE-NEW-REF" });
      const concurrent = await Promise.all([receive(f, next), receive(f, next)]); expect(concurrent.map(row => row.statusCode).sort()).toEqual([201, 409]);
    } finally { await PharmacyPurchaseReceipt.createIndexes(); }
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(2);
  });
  it("rolls back the first lot, movements, progress and command when a later line fails", async () => {
    const f = await fixture(); await commit(f); const body = delivery(f), requestKey = key();
    body.lines.push({ ...body.lines[0], lineId: key(), expiry: { precision: "day", value: "2020-01-01" } });
    expect((await receive(f, body, requestKey)).statusCode).toBe(400);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await OperationReceipt.exists({ key: requestKey })).toBeNull(); expect((await read(f)).json().data).toMatchObject({ revision: 1, receiptCount: 0 });
  });
  it("rolls back posting and receiving on required audit failures", async () => {
    const f = await fixture(), original = AuditLog.create.bind(AuditLog);
    const fail = (action: string) => vi.spyOn(AuditLog, "create").mockImplementation(((rows: any, ...args: any[]) => { if ((Array.isArray(rows) ? rows[0] : rows).action === action) throw new Error("Synthetic audit failure"); return (original as any)(rows, ...args); }) as any);
    let spy = fail("PHARMACY_PURCHASE_POSTED"); try { expect((await commit(f)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect((await read(f)).json().data.status).toBe("draft"); expect((await commit(f)).statusCode).toBe(200);
    spy = fail("PHARMACY_PURCHASE_RECEIVED"); try { expect((await receive(f)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); expect(await PharmacyPurchaseReceipt.countDocuments({ purchaseId: f.purchase.id })).toBe(0);
  });
  it("requires purchasing plus receiving grants and reauthorizes operation recovery after revocation", async () => {
    const f = await fixture(["PHARMACY_PURCHASE"]), requestKey = key(); expect((await commit(f, {}, requestKey)).statusCode).toBe(200);
    expect((await receive(f)).statusCode).toBe(403);
    expect((await recover(f, "post", requestKey)).statusCode).toBe(200);
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: ["PHARMACY_RECEIVE_STOCK"] } });
    expect((await read(f)).statusCode).toBe(403); expect((await recover(f, "post", requestKey)).statusCode).toBe(403);
  });
  it("enforces tenant/branch and initiating-actor recovery boundaries", async () => {
    const f = await fixture(), other = await fixture(), requestKey = key(); await commit(f, {}, requestKey);
    expect((await post(other, `purchases/${f.purchase.id}/post`, posting(other))).statusCode).toBe(404);
    const user = await User.create({ name: "Other buyer", email: `${key()}@example.test`, role: f.role });
    await OrgMember.create({ organizationId: f.organizationId, userId: user.id, role: f.role, locationAccess: { mode: "all", locationIds: [] } });
    const auth = await createAuthSession({ id: user.id, role: f.role, email: user.email!, organization_id: f.organizationId });
    const response = await recover({ ...f, headers: { authorization: `Bearer ${auth.accessToken}` } }, "post", requestKey); expect(response.statusCode).toBe(404); expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("retains history and recovery after disable while blocking new receipts", async () => {
    const f = await fixture(), requestKey = key(); await commit(f, {}, requestKey);
    await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": false } });
    expect((await receive(f)).statusCode).toBe(409); expect((await read(f)).statusCode).toBe(200); expect((await recover(f, "post", requestKey)).statusCode).toBe(200);
  });
  it.each(["mismatch", "stale supplier", "missing profile", "wrong state split", "unregistered tax", "changed units"])("refuses posting with %s", async kind => {
    const f = await fixture(); let fields = {};
    if (kind === "mismatch") fields = { roundOffPaise: 1 };
    if (kind === "stale supplier") fields = { expectedSupplierRevision: 1 };
    if (kind === "missing profile") await PharmacyTaxProfile.deleteOne({ locationId: f.locationId });
    if (kind === "wrong state split") fields = { taxMode: "igst" };
    if (kind === "unregistered tax") { await PharmacyParty.updateOne({ _id: f.party.id }, { $set: { gstRegistration: "unregistered" }, $unset: { gstin: 1 } }); await PharmacyPurchase.updateOne({ _id: f.purchase.id }, { $unset: { "supplierSnapshot.gstin": 1 } }); }
    if (kind === "changed units") await Medicine.updateOne({ _id: f.medicine.id }, { $set: { "unitDefinition.version": 2 } });
    expect((await commit(f, fields)).statusCode).toBe(409); expect((await read(f)).json().data.status).toBe("draft");
  });
  it("handles explicit round-off and interstate supplier GST using the reviewed recipient profile", async () => {
    const f = await fixture(); await PharmacyParty.updateOne({ _id: f.party.id }, { $set: { gstin: "29ABCDE1234F1Z5" } });
    await PharmacyPurchase.updateOne({ _id: f.purchase.id }, { $set: { "supplierSnapshot.gstin": "29ABCDE1234F1Z5", statedTotalPaise: 119 } });
    const response = await commit(f, { supplierStateCode: "29", taxMode: "igst", roundOffPaise: 1 }); expect(response.statusCode, response.body).toBe(200);
    expect((await read(f)).json().data.posting.calculation.totals).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: 18, roundOffPaise: 1, payablePaise: 119 });
  });
  it("keeps receipt history append-only, scoped and bounded, with original receipt recovery after a sale", async () => {
    const f = await fixture(); await commit(f); const body = delivery(f), requestKey = key(), first = await receive(f, body, requestKey);
    expect(first.statusCode, first.body).toBe(201); await dispenseMedicineFEFO(f.medicine.id, f.locationId, 1);
    expect((await recover(f, "receipt", requestKey)).json().data.lines).toEqual(first.json().data.lines);
    const history = await app.inject({ method: "GET", url: `/api/pharmacy/purchases/${f.purchase.id}/receipts?locationId=${f.locationId}`, headers: f.headers });
    expect(history.statusCode).toBe(200); expect(history.json().data).toMatchObject({ nextCursor: null, items: [{ deliveryReference: body.deliveryReference }] });
    await expect(PharmacyPurchaseReceipt.updateOne({ _id: first.json().data.receiptId }, { $set: { lines: [] } })).rejects.toThrow(/append-only/);
    expect((await receive(f, { ...body, expectedRevision: 2 })).statusCode).toBe(409);
  });
  it("requires the installed receipt identity index without mutating live-style index readiness", async () => {
    const f = await fixture(); await commit(f); await MedicineBatch.collection.dropIndex("pharmacy_receipt_line_v1");
    try { expect((await receive(f)).statusCode).toBe(503); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); }
    finally { await MedicineBatch.createIndexes(); }
  });
  it("refuses changed units, source overreceipts, corrupt progress and excess deliveries without stock effects", async () => {
    const f = await fixture(); await commit(f);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { "unitDefinition.unitsPerPack": 20 } });
    expect((await receive(f)).statusCode).toBe(409);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { "unitDefinition.unitsPerPack": 10 } });
    const over = delivery(f); over.lines[0].freeBaseUnits = 2; expect((await receive(f, over)).statusCode).toBe(409);
    await PharmacyPurchase.updateOne({ _id: f.purchase.id }, { $set: { "receiptProgress.0.costPaise": 1 } });
    expect((await receive(f)).statusCode).toBe(409);
    await PharmacyPurchase.updateOne({ _id: f.purchase.id }, { $set: { "receiptProgress.0.costPaise": 0, receiptCount: 100 } });
    expect((await receive(f)).statusCode).toBe(409);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
  });
  it("rejects forged money, fractional/null units, hidden delivery identities and consumer roles", async () => {
    const f = await fixture(); await commit(f);
    const body = delivery(f);
    for (const patch of [{ billedBaseUnits: 0.5 }, { billedBaseUnits: null }, { costPaise: 1 }, { purchaseLineId: "unknown-line" }]) {
      const result = await post(f, `purchases/${f.purchase.id}/receipts`, { ...body, lines: [{ ...body.lines[0], ...patch }] }); expect([400, 409]).toContain(result.statusCode);
    }
    expect((await receive(f, { ...body, deliveryReference: "DELIVERY\u200bHIDDEN" })).statusCode).toBe(400);
    const consumer = await User.create({ name: "Consumer", email: `${key()}@example.test`, role: "patient" });
    const auth = await createAuthSession({ id: consumer.id, role: "patient", email: consumer.email!, organization_id: f.organizationId });
    expect((await receive({ ...f, headers: { authorization: `Bearer ${auth.accessToken}` } })).statusCode).toBe(403);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
  });
  it("makes legacy inward explicitly unlinked and unable to attach a posted purchase", async () => {
    const f = await fixture(); const payload = { medicineId: f.medicine.id, locationId: f.locationId, batchNumber: "UNLINKED", expiryDate: "2099-12-31", quantity: 1, purchaseCost: 1, sellingPrice: 10 };
    expect((await post(f, "batches", payload)).statusCode).toBe(400);
    expect((await post(f, "batches", { ...payload, unlinkedInwardReason: "Synthetic unlinked source", purchaseId: f.purchase.id })).statusCode).toBe(400);
    expect((await post(f, "batches", { ...payload, unlinkedInwardReason: "Synthetic unlinked source" })).statusCode).toBe(201);
    expect((await read(f)).json().data.status).toBe("draft");
    expect((await StockMovement.findOne({ medicineId: f.medicine.id, kind: "receipt" }))!.notes).toMatch(/Synthetic unlinked/);
  });
});

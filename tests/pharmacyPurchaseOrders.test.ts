import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyPurchaseFixture as fixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { PharmacyPurchaseOrder } from "../models/PharmacyPurchaseOrder.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
const key = () => crypto.randomUUID();
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, path: string, body: object, requestKey = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": requestKey }, payload: body });
const draft = (f: Fixture, quantity = 4) => ({ locationId: f.locationId, supplierId: f.party.id, expectedSupplierRevision: 0, reference: `OWNER-${key()}`, notes: "Synthetic only", lines: [{ lineId: key(), medicineId: f.medicine.id, expectedUnitVersion: 1, packs: Math.floor(quantity / 10), looseUnits: quantity % 10 }] });
const act = (f: Fixture, id: string, expectedRevision: number, action: string, fields = {}, requestKey = key()) => post(f, `purchase-orders/${id}/actions`, { locationId: f.locationId, expectedRevision, action, reference: "Actual synthetic supplier communication", confirmed: true, ...fields }, requestKey);
const read = (f: Fixture, id: string) => app.inject({ method: "GET", url: `/api/pharmacy/purchase-orders/${id}?locationId=${f.locationId}`, headers: f.headers });
const list = (f: Fixture) => app.inject({ method: "GET", url: `/api/pharmacy/purchase-orders?locationId=${f.locationId}`, headers: f.headers });
async function order(f: Fixture, quantity = 4) { const result = await post(f, "purchase-orders", draft(f, quantity)); expect(result.statusCode, result.body).toBe(201); return result.json().data; }
async function sent(f: Fixture, quantity = 4) { const row = await order(f, quantity), result = await act(f, row.id, 0, "submit", { channel: "whatsapp" }); expect(result.statusCode, result.body).toBe(200); return result.json().data; }
async function posted(f: Fixture) {
  const result = await post(f, `purchases/${f.purchase.id}/post`, { locationId: f.locationId, expectedRevision: 0, expectedSupplierRevision: 0, supplierStateCode: "27", taxMode: "sgst", costTreatment: "exclude_tax", roundOffPaise: 0, reviewReference: "Synthetic supplier invoice review" });
  expect(result.statusCode, result.body).toBe(200);
}

it("creates a reusable saved draft and stable owner reference without creating any stock, invoice or payable", async () => {
  const f = await fixture(), input = draft(f, 21), requestKey = key();
  const first = await post(f, "purchase-orders", input, requestKey); expect(first.statusCode, first.body).toBe(201);
  const row = first.json().data; expect(row).toMatchObject({ state: "draft", reference: input.reference, revision: 0, lines: [{ packs: 2, looseUnits: 1, quantity: 21 }], comparison: [{ ordered: 21, accepted: null, received: 0, invoiced: 0 }] });
  const retry = await post(f, "purchase-orders", input, requestKey); expect(retry.json().data).toMatchObject({ id: row.id, replayed: true });
  expect((await post(f, "purchase-orders", input)).statusCode).toBe(409);
  expect(await PharmacyPurchaseOrder.countDocuments({ locationId: f.locationId })).toBe(1);
  expect(await MedicineBatch.countDocuments({ locationId: f.locationId })).toBe(0); expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(0);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); expect((await PharmacyPurchase.findById(f.purchase.id))!.status).toBe("draft");
  const recover = await app.inject({ method: "GET", url: `/api/pharmacy/purchase-order-commands/${requestKey}?locationId=${f.locationId}&kind=save`, headers: f.headers });
  expect(recover.statusCode, recover.body).toBe(200); expect(recover.json().data.id).toBe(row.id);
  expect((await post(f, "purchase-orders", { ...input, notes: "Different request" }, requestKey)).statusCode).toBe(409);
});

it("saves edits with exact revisions, snapshots parties and refuses changes after the order is sent", async () => {
  const f = await fixture(), input = draft(f), original = await post(f, "purchase-orders", input), row = original.json().data;
  const update = (expectedRevision: number) => app.inject({ method: "PUT", url: `/api/pharmacy/purchase-orders/${row.id}`, headers: { ...f.headers, "idempotency-key": key() }, payload: { ...input, notes: "Updated draft", expectedRevision } });
  expect((await update(0)).statusCode).toBe(200); expect((await update(0)).statusCode).toBe(409);
  expect((await act(f, row.id, 1, "submit", { channel: "phone" })).statusCode).toBe(200);
  expect((await update(2)).statusCode).toBe(409);
  const current = (await read(f, row.id)).json().data; expect(current).toMatchObject({ state: "submitted", sent: { channel: "phone" }, supplierSnapshot: { name: f.party.name }, buyerSnapshot: { branch: "Synthetic receiving branch" } });
});

it("records partial supplier acceptance, unavailable goods, quoted terms and real dispatch without touching inventory", async () => {
  const f = await fixture(), row = await sent(f, 10);
  const response = await act(f, row.id, 1, "respond", { lines: [{ lineId: row.lines[0].lineId, acceptedQuantity: 4, quotedUnitPricePaise: 123, note: "Synthetic 6 unavailable; no automatic substitution" }] });
  expect(response.statusCode, response.body).toBe(200); expect(response.json().data).toMatchObject({ status: "partially_accepted", response: { lines: [{ acceptedQuantity: 4, quotedUnitPricePaise: 123 }] }, comparison: [{ ordered: 10, accepted: 4, shortAccepted: 6 }] });
  const dispatched = await act(f, row.id, 2, "dispatch", { expectedDelivery: "2099-01-01" }); expect(dispatched.statusCode, dispatched.body).toBe(200); expect(dispatched.json().data.status).toBe("dispatched");
  expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(0);
  expect((await act(f, row.id, 3, "respond", { lines: [{ lineId: row.lines[0].lineId, acceptedQuantity: 0 }] })).statusCode).toBe(409);
});

it("reuses posted invoices and the existing partial stock receiver for ordered/invoiced/received comparison", async () => {
  const f = await fixture(), row = await sent(f);
  expect((await act(f, row.id, 1, "link_invoice", { purchaseId: f.purchase.id })).statusCode).toBe(409);
  await posted(f);
  const available = await app.inject({ method: "GET", url: `/api/pharmacy/purchases?locationId=${f.locationId}&supplierId=${f.party.id}&status=posted&unlinked=true`, headers: f.headers });
  expect(available.statusCode, available.body).toBe(200); expect(available.json().data.items.map((item: any) => item.id)).toEqual([f.purchase.id]);
  const linkKey = key(), fields = { purchaseId: f.purchase.id }, linked = await act(f, row.id, 1, "link_invoice", fields, linkKey);
  expect(linked.statusCode, linked.body).toBe(200); expect(linked.json().data).toMatchObject({ status: "billed", invoiceCount: 1, comparison: [{ ordered: 4, invoiced: 4, received: 0 }] });
  expect((await list(f)).json().data.items).toMatchObject([{ id: row.id, state: "submitted", status: "billed" }]);
  expect((await act(f, row.id, 1, "link_invoice", fields, linkKey)).json().data).toMatchObject({ id: row.id, invoiceCount: 1, replayed: true });
  expect(await MedicineBatch.countDocuments({ locationId: f.locationId })).toBe(0);
  const remaining = await app.inject({ method: "GET", url: `/api/pharmacy/purchases?locationId=${f.locationId}&supplierId=${f.party.id}&status=posted&unlinked=true`, headers: f.headers });
  expect(remaining.json().data.items).toEqual([]);
  const receive = (revision: number, billed: number, free: number) => ({ locationId: f.locationId, expectedRevision: revision, deliveryReference: `ACTUAL-${key()}`, lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: billed, freeBaseUnits: free, batchNumber: "ACTUAL-PRINTED", expiry: { precision: "month", value: "2099-12" } }] });
  const firstInput = receive(1, 1, 0), receiptKey = key();
  const first = await post(f, `purchases/${f.purchase.id}/receipts`, firstInput, receiptKey); expect(first.statusCode, first.body).toBe(201);
  expect((await post(f, `purchases/${f.purchase.id}/receipts`, firstInput, receiptKey)).json().data.replayed).toBe(true);
  expect((await read(f, row.id)).json().data).toMatchObject({ status: "partially_received", comparison: [{ invoiced: 4, received: 1, pendingReceipt: 3 }] });
  expect((await list(f)).json().data.items).toMatchObject([{ id: row.id, state: "submitted", status: "partially_received" }]);
  const last = await post(f, `purchases/${f.purchase.id}/receipts`, receive(2, 2, 1)); expect(last.statusCode, last.body).toBe(201);
  expect((await read(f, row.id)).json().data).toMatchObject({ status: "received", comparison: [{ received: 4, pendingInvoice: 0, pendingReceipt: 0 }] });
  expect((await list(f)).json().data.items).toMatchObject([{ id: row.id, state: "submitted", status: "received" }]);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
  await expect(PharmacyPurchase.updateOne({ _id: f.purchase.id }, { $set: { purchaseOrderId: new mongoose.Types.ObjectId() } })).rejects.toThrow(/cannot be reassigned/);
});

it("batches history fulfilment across orders, isolates tenants and omits private terms", async () => {
  const f = await fixture(), row = await sent(f, 10), other = await sent(f);
  await act(f, row.id, 1, "respond", { lines: [{ lineId: row.lines[0].lineId, acceptedQuantity: 4, quotedUnitPricePaise: 123, note: "Private supplier terms" }] });
  await posted(f); expect((await act(f, row.id, 2, "link_invoice", { purchaseId: f.purchase.id })).statusCode).toBe(200);
  const foreign = await fixture(), foreignOrder = await sent(foreign); await posted(foreign);
  expect((await act(foreign, foreignOrder.id, 1, "link_invoice", { purchaseId: foreign.purchase.id })).statusCode).toBe(200);
  const receive = await post(f, `purchases/${f.purchase.id}/receipts`, { locationId: f.locationId, expectedRevision: 1, deliveryReference: key(), lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: 3, freeBaseUnits: 1, batchNumber: "ACTUAL-LIST", expiry: { precision: "month", value: "2099-12" } }] });
  expect(receive.statusCode, receive.body).toBe(201);
  const aggregate = vi.spyOn(PharmacyPurchase, "aggregate");
  try {
    const result = await list(f); expect(result.statusCode, result.body).toBe(200);
    expect(aggregate).toHaveBeenCalledOnce();
    expect(result.json().data.items).toMatchObject([{ id: other.id, status: "submitted" }, { id: row.id, status: "received", state: "partially_accepted" }]);
    expect(result.body).not.toContain("Private supplier terms"); expect(result.body).not.toContain("receiptProgress"); expect(result.body).not.toContain(foreignOrder.id);
    expect(result.json().data.items[1]).not.toHaveProperty("lines");
  } finally { aggregate.mockRestore(); }
});

it("requires explicit over-supply review and rejects unknown or substituted product identities", async () => {
  const f = await fixture(), row = await sent(f, 2); await posted(f);
  const blocked = await act(f, row.id, 1, "link_invoice", { purchaseId: f.purchase.id }); expect(blocked.statusCode, blocked.body).toBe(409); expect(blocked.body).toContain("variance");
  const accepted = await act(f, row.id, 1, "link_invoice", { purchaseId: f.purchase.id, confirmVariance: true }); expect(accepted.statusCode, accepted.body).toBe(200); expect(accepted.json().data.comparison[0].overInvoiced).toBe(2);
  const other = await fixture(), row2 = await sent(other);
  await Medicine.updateOne({ _id: other.medicine.id }, { $inc: { "unitDefinition.version": 1 } });
  expect((await act(other, row2.id, 1, "submit", { channel: "email" })).statusCode).toBe(409);
  expect((await post(other, "purchase-orders", draft(other))).statusCode).toBe(409);
  const third = await fixture(), different = await Medicine.create({ locationId: third.locationId, name: "Different exact product", genericName: "Different", price: 10, stockQuantity: 0, unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } });
  const input = draft(third); input.lines[0].medicineId = different.id;
  const created = await post(third, "purchase-orders", input), differentOrder = created.json().data;
  expect(created.statusCode, created.body).toBe(201); expect((await act(third, differentOrder.id, 0, "submit", { channel: "email" })).statusCode).toBe(200);
  await posted(third);
  const substitute = await act(third, differentOrder.id, 1, "link_invoice", { purchaseId: third.purchase.id, confirmVariance: true });
  expect(substitute.statusCode, substitute.body).toBe(409); expect(substitute.body).toContain("substituted");
});

it("allows only one concurrent order to claim an invoice and cancels only unbilled orders", async () => {
  const f = await fixture(), a = await sent(f), b = await sent(f); await posted(f);
  const results = await Promise.all([act(f, a.id, 1, "link_invoice", { purchaseId: f.purchase.id }), act(f, b.id, 1, "link_invoice", { purchaseId: f.purchase.id })]);
  expect(results.map(row => row.statusCode).sort()).toEqual([200, 409]);
  const winner = results[0].statusCode === 200 ? a : b, loser = winner === a ? b : a;
  expect((await act(f, winner.id, 2, "cancel")).statusCode).toBe(409);
  expect((await act(f, loser.id, 1, "cancel")).statusCode).toBe(200);
});

it("closes an actual unfilled remainder only after receiving linked invoices, preserving the shortfall and stock", async () => {
  const f = await fixture(), row = await sent(f, 10); await posted(f);
  expect((await act(f, row.id, 1, "link_invoice", { purchaseId: f.purchase.id })).statusCode).toBe(200);
  expect((await act(f, row.id, 2, "close_remainder")).statusCode).toBe(409);
  const delivery = { locationId: f.locationId, expectedRevision: 1, deliveryReference: `ACTUAL-${key()}`, lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: 3, freeBaseUnits: 1, batchNumber: "PRINTED-ONLY", expiry: { precision: "month", value: "2099-12" } }] };
  const received = await post(f, `purchases/${f.purchase.id}/receipts`, delivery); expect(received.statusCode, received.body).toBe(201);
  const closed = await act(f, row.id, 2, "close_remainder"); expect(closed.statusCode, closed.body).toBe(200);
  expect(closed.json().data).toMatchObject({ status: "closed", comparison: [{ ordered: 10, invoiced: 4, received: 4, pendingInvoice: 6 }], closure: { reference: "Actual synthetic supplier communication" } });
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(4);
  expect((await act(f, row.id, 3, "dispatch")).statusCode).toBe(409);
});

it("rolls back order and invoice linkage when mandatory audit fails", async () => {
  const f = await fixture(), row = await sent(f); await posted(f);
  const audit = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(Error("Synthetic audit outage"));
  try { expect((await act(f, row.id, 1, "link_invoice", { purchaseId: f.purchase.id })).statusCode).toBe(500); } finally { audit.mockRestore(); }
  expect((await PharmacyPurchase.findById(f.purchase.id))!.purchaseOrderId).toBeUndefined(); expect((await PharmacyPurchaseOrder.findById(row.id))!.invoiceCount).toBe(0);
});

it("enforces organization/branch access and permissions without exposing foreign supplier data", async () => {
  const f = await fixture(), row = await order(f), foreign = await fixture();
  const foreignRead = await read(foreign, row.id); expect(foreignRead.statusCode).toBe(404); expect(foreignRead.body).not.toContain(f.party.name);
  expect((await act(foreign, row.id, 0, "cancel")).statusCode).toBe(404);
  const foreignList = await app.inject({ method: "GET", url: `/api/pharmacy/purchase-orders?locationId=${foreign.locationId}&supplierId=${f.party.id}`, headers: foreign.headers });
  expect(foreignList.statusCode, foreignList.body).toBe(200); expect(foreignList.json().data.items).toEqual([]);
  expect((await post(f, "purchase-orders", { ...draft(f), supplierId: foreign.party.id })).statusCode).toBe(409);
  expect((await post(f, "purchase-orders", { ...draft(f), lines: [{ ...draft(f).lines[0], medicineId: foreign.medicine.id }] })).statusCode).toBe(409);
  await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: [] } });
  expect((await post(f, "purchase-orders", draft(f))).statusCode).toBe(403);
});

it("rejects unconfirmed actions, malformed quantities, hidden stock fields and stale suppliers", async () => {
  const f = await fixture(), input = draft(f), row = await order(f);
  expect((await post(f, "purchase-orders", { ...input, stockQuantity: 100 })).statusCode).toBe(400);
  expect((await post(f, "purchase-orders", { ...input, lines: [{ ...input.lines[0], packs: "1" }] })).statusCode).toBe(400);
  expect((await post(f, "purchase-orders", { ...input, lines: [input.lines[0], { ...input.lines[0], lineId: key() }] })).statusCode).toBe(400);
  expect((await act(f, row.id, 0, "submit", { channel: "email", confirmed: false })).statusCode).toBe(400);
  await PharmacyParty.updateOne({ _id: f.party.id }, { $inc: { revision: 1 } });
  expect((await act(f, row.id, 0, "submit", { channel: "email" })).statusCode).toBe(409);
});

it("allows ordering during exclusive offline stock ownership without changing its stock or stop signal", async () => {
  const f = await fixture(), owner = key(); await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyOfflineOwner: owner } });
  const row = await sent(f); expect(row.state).toBe("submitted");
  expect((await Location.findById(f.locationId))!).toMatchObject({ pharmacyOfflineOwner: owner });
  expect((await Location.findById(f.locationId))!.pharmacySaleControlUpdatedAt).toBeUndefined();
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
});

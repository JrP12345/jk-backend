import crypto from "node:crypto";
import mongoose from "mongoose";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
const storage = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn(), download: vi.fn() }));
vi.mock("../utilities/r2.ts", () => ({ storeVerifiedObject: storage.put, deleteObjectFromStorage: storage.remove, generatePresignedDownloadUrl: storage.download }));
import { app } from "../index.ts";
import { pharmacyPurchaseFixture as fixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { PharmacyPurchaseOrder } from "../models/PharmacyPurchaseOrder.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Location } from "../models/Location.ts";
import { Role } from "../models/Role.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
type Fixture = Awaited<ReturnType<typeof fixture>>;
let remote = 1;
const key = () => crypto.randomUUID();
const post = (f: Fixture, path: string, payload: object, requestKey = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": requestKey }, payload, remoteAddress: `192.0.2.${remote++ % 250 + 1}` });
const get = (f: Fixture, path: string) => app.inject({ method: "GET", url: `/api/pharmacy/${path}`, headers: f.headers });
const publicPost = (path: string, token: string, payload = {}, requestKey = key()) => app.inject({ method: "POST", url: `/api/public/pharmacy-supplier-order/${path}`, headers: { "idempotency-key": requestKey }, payload: { token, ...payload }, remoteAddress: `192.0.2.${remote++ % 250 + 1}` });
async function sent(f: Fixture) {
  const draft = await post(f, "purchase-orders", { locationId: f.locationId, supplierId: f.party.id, expectedSupplierRevision: 0, reference: `SUPPLIER-${key()}`, notes: "Order-specific note only", lines: [{ lineId: key(), medicineId: f.medicine.id, expectedUnitVersion: 1, packs: 1, looseUnits: 0 }] });
  expect(draft.statusCode, draft.body).toBe(201); const row = draft.json().data;
  const result = await post(f, `purchase-orders/${row.id}/actions`, { locationId: f.locationId, expectedRevision: 0, action: "submit", channel: "phone", reference: "Actual supplier request", confirmed: true });
  expect(result.statusCode, result.body).toBe(200); return result.json().data;
}
async function issue(f: Fixture, order: any, requestKey = key()) {
  const result = await post(f, `purchase-orders/${order.id}/supplier-link`, { locationId: f.locationId, expectedRevision: order.revision, action: "issue", expiresInHours: 72, confirmed: true }, requestKey);
  expect(result.statusCode, result.body).toBe(200); return result.json().data;
}
const file = (fields = {}) => ({ name: "actual-invoice.pdf", kind: "invoice", contentType: "application/pdf", base64Data: Buffer.from("%PDF-1.7\nflattened synthetic invoice\n%%EOF").toString("base64"), confirmed: true, ...fields });
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
beforeEach(() => { vi.clearAllMocks(); storage.put.mockImplementation(async () => `tenants/synthetic/verified/${key()}.pdf`); storage.remove.mockResolvedValue(undefined); storage.download.mockResolvedValue("https://private-storage.example.test/file?signature=temporary"); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("issues one recoverable, encrypted order-only capability and never exposes it through staff order reads", async () => {
  const f = await fixture(), order = await sent(f), requestKey = key(), access = await issue(f, order, requestKey), retry = await issue(f, order, requestKey);
  expect(retry).toEqual(access); expect(access.token).toMatch(/^[a-f0-9]{64}$/);
  const stored = await PharmacyPurchaseOrder.findById(order.id).lean(); expect(stored!.supplierAccess!.tokenHash).not.toBe(access.token); expect(stored!.supplierAccess!.tokenCiphertext).not.toContain(access.token);
  const read = await get(f, `purchase-orders/${order.id}?locationId=${f.locationId}`); expect(read.body).not.toContain(access.token); expect(read.body).not.toContain("supplierAccess");
  const result = await publicPost("read", access.token); expect(result.statusCode, result.body).toBe(200); expect(result.headers["cache-control"]).toBe("no-store"); expect(result.headers["referrer-policy"]).toBe("no-referrer");
  const view = result.json().data; expect(view).toMatchObject({ reference: order.reference, revision: 2, lines: [{ quantity: 10, unit: "tablet" }] });
  for (const field of ["organizationId", "locationId", "supplierId", "medicineId", "supplierAccess", "invoices", "stockQuantity", "objectKey", "createdBy"]) expect(result.body).not.toContain(`"${field}"`);
});

it("rejects cross-tenant access, stale link edits, expired/replaced/revoked links and unavailable suppliers", async () => {
  const f = await fixture(), foreign = await fixture(), order = await sent(f), access = await issue(f, order);
  expect((await get(foreign, `purchase-orders/${order.id}/collaboration?locationId=${foreign.locationId}`)).statusCode).toBe(404);
  expect((await post(f, `purchase-orders/${order.id}/supplier-link`, { locationId: f.locationId, expectedRevision: 1, action: "issue", expiresInHours: 72, confirmed: true })).statusCode).toBe(409);
  const rotated = await issue(f, { ...order, revision: 2 }); expect((await publicPost("read", access.token)).statusCode).toBe(404);
  const revoke = await post(f, `purchase-orders/${order.id}/supplier-link`, { locationId: f.locationId, expectedRevision: 3, action: "revoke", confirmed: true }); expect(revoke.statusCode, revoke.body).toBe(200); expect((await publicPost("read", rotated.token)).statusCode).toBe(404);
  const again = await issue(f, { ...order, revision: 4 }); await PharmacyPurchaseOrder.updateOne({ _id: order.id }, { $set: { "supplierAccess.expiresAt": new Date(Date.now() - 1000) } }); expect((await publicPost("read", again.token)).statusCode).toBe(404);
  const active = await issue(f, { ...order, revision: 5 }); await PharmacyParty.updateOne({ _id: f.party.id }, { $set: { archived: true } }); expect((await publicPost("read", active.token)).statusCode).toBe(404);
});

it("accepts explicit exact supplier quantities and dispatch with stable retries and honest external audit identity", async () => {
  const f = await fixture(), order = await sent(f), access = await issue(f, order), requestKey = key();
  const input = { action: "respond", expectedRevision: 2, reference: "Supplier acceptance REF-1", confirmed: true, lines: [{ lineId: order.lines[0].lineId, acceptedQuantity: 7, quotedUnitPricePaise: 150, note: "Three unavailable" }] };
  const result = await publicPost("respond", access.token, { input }, requestKey); expect(result.statusCode, result.body).toBe(200); expect(result.json().data).toMatchObject({ state: "partially_accepted", revision: 3, response: { lines: [{ acceptedQuantity: 7 }] } });
  expect((await publicPost("respond", access.token, { input }, requestKey)).statusCode).toBe(200);
  expect((await publicPost("respond", access.token, { input: { ...input, reference: "Changed" } }, requestKey)).statusCode).toBe(409);
  expect((await publicPost("respond", access.token, { input })).statusCode).toBe(409);
  expect((await publicPost("respond", access.token, { input: { ...input, expectedRevision: 3, lines: [{ ...input.lines[0], acceptedQuantity: 11 }] } })).statusCode).toBe(400);
  expect((await publicPost("respond", access.token, { input: { ...input, expectedRevision: 3, action: "cancel" } })).statusCode).toBe(403);
  const dispatched = await publicPost("respond", access.token, { input: { action: "dispatch", expectedRevision: 3, reference: "Carrier actual docket", expectedDelivery: "2026-12-20", confirmed: true } }); expect(dispatched.statusCode, dispatched.body).toBe(200);
  expect(dispatched.json().data).toMatchObject({ state: "dispatched", dispatch: { reference: "Carrier actual docket" } });
  const audits = await AuditLog.find({ targetId: order.id, action: "PHARMACY_ORDER_SUPPLIER_RESPOND" }).lean(); expect(audits).toHaveLength(1); expect(audits[0].userId).toBeUndefined(); expect(audits[0].details.actorType).toBe("supplier_link_holder");
  expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(0); expect(await MedicineBatch.countDocuments({ locationId: f.locationId })).toBe(0); expect((await PharmacyPurchase.findById(f.purchase.id))!.status).toBe("draft");
});

it("retains invoice evidence without posting stock and isolates internal attachments from suppliers", async () => {
  const f = await fixture(), foreign = await fixture(), order = await sent(f), access = await issue(f, order), requestKey = key();
  const staffFile = file({ locationId: f.locationId, supplierVisible: false });
  const internal = await post(f, `purchase-orders/${order.id}/documents`, staffFile, requestKey); expect(internal.statusCode, internal.body).toBe(200); const doc = internal.json().data.documents[0];
  expect((await post(f, `purchase-orders/${order.id}/documents`, staffFile, requestKey)).statusCode).toBe(200); expect(storage.put).toHaveBeenCalledOnce();
  expect((await publicPost("read", access.token)).json().data.documents).toEqual([]);
  expect((await publicPost("document-download", access.token, { documentId: doc.id })).statusCode).toBe(404);
  expect((await get(foreign, `purchase-orders/${order.id}/document-download?locationId=${foreign.locationId}&documentId=${doc.id}`)).statusCode).toBe(404);
  expect((await post(f, `purchase-orders/${order.id}/documents`, { ...staffFile, name: "different.pdf" }, requestKey)).statusCode).toBe(409);
  const uploaded = await publicPost("documents", access.token, file()); expect(uploaded.statusCode, uploaded.body).toBe(200); const supplierDoc = uploaded.json().data.documents[0]; expect(supplierDoc).toMatchObject({ source: "supplier_link", supplierVisible: true });
  expect(uploaded.body).not.toContain("objectKey"); expect(uploaded.body).not.toContain("sha256");
  const download = await publicPost("document-download", access.token, { documentId: supplierDoc.id }); expect(download.statusCode, download.body).toBe(200); expect(storage.download.mock.calls.at(-1)![1]).toBeLessThanOrEqual(60);
  const archive = await get(f, `suppliers/${f.party.id}/archive?locationId=${f.locationId}&section=documents`); expect(archive.statusCode, archive.body).toBe(200); expect(archive.json().data.items[0].documents).toHaveLength(2); expect(archive.body).not.toContain("objectKey");
  expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(0); expect((await PharmacyPurchase.findById(f.purchase.id))!.status).toBe("draft");
});

it("deduplicates identical evidence, rejects active or oversized files and cleans unretained storage", async () => {
  const f = await fixture(), order = await sent(f), access = await issue(f, order), body = file();
  expect((await publicPost("documents", access.token, body)).statusCode).toBe(200); expect((await publicPost("documents", access.token, body)).statusCode).toBe(200);
  expect((await PharmacyPurchaseOrder.findById(order.id))!.documents).toHaveLength(1); expect(storage.put).toHaveBeenCalledOnce(); expect(storage.remove).not.toHaveBeenCalled();
  const active = file({ base64Data: Buffer.from("%PDF-1.7\n/JavaScript(alert(1))\n%%EOF").toString("base64") }); expect((await publicPost("documents", access.token, active)).statusCode).toBe(400);
  expect((await publicPost("documents", access.token, file({ contentType: "text/html" }))).statusCode).toBe(400);
  expect((await publicPost("documents", access.token, file({ name: "../../other.pdf" }))).statusCode).toBe(400);
  expect((await publicPost("documents", access.token, file({ base64Data: Buffer.alloc(4 * 1024 * 1024 + 1, 65).toString("base64") }))).statusCode).toBe(400);
  storage.put.mockRejectedValueOnce(Error("Storage offline")); expect((await publicPost("documents", access.token, file({ name: "retry.pdf" }))).statusCode).toBe(503);
  expect((await PharmacyPurchaseOrder.findById(order.id))!.documents).toHaveLength(1);
});

it("rolls back link and document records when required audit fails", async () => {
  const f = await fixture(), order = await sent(f), spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(Error("Audit unavailable"));
  const failed = await post(f, `purchase-orders/${order.id}/supplier-link`, { locationId: f.locationId, expectedRevision: 1, action: "issue", expiresInHours: 72, confirmed: true }); expect(failed.statusCode).toBe(503); expect((await PharmacyPurchaseOrder.findById(order.id))!.supplierAccess).toBeUndefined(); spy.mockRestore();
  const access = await issue(f, order); vi.spyOn(AuditLog, "create").mockRejectedValueOnce(Error("Audit unavailable"));
  expect((await publicPost("documents", access.token, file())).statusCode).toBe(503); expect((await PharmacyPurchaseOrder.findById(order.id))!.documents).toHaveLength(0); expect(storage.remove).toHaveBeenCalledOnce();
});

it("queues exactly one encrypted email to the actual supplier and exposes delivery state without secrets", async () => {
  vi.stubEnv("SMTP_HOST", "smtp.example.test"); vi.stubEnv("SMTP_USER", "synthetic"); vi.stubEnv("SMTP_PASS", "synthetic"); vi.stubEnv("APP_URL", "https://ekavyu.example.test");
  const f = await fixture(); await PharmacyParty.updateOne({ _id: f.party.id }, { $set: { email: "supplier@example.test" } });
  const order = await sent(f), access = await issue(f, order), requestKey = key(), input = { locationId: f.locationId, expectedRevision: 2, confirmed: true };
  const result = await post(f, `purchase-orders/${order.id}/supplier-email`, input, requestKey); expect(result.statusCode, result.body).toBe(200); expect(result.json().data.email.status).toBe("pending");
  expect((await post(f, `purchase-orders/${order.id}/supplier-email`, input, requestKey)).statusCode).toBe(200);
  const rows = await OutboundMessage.find({ idempotencyKey: `pharmacy-supplier-email:${order.id}:${requestKey}` }).select("+sensitivePayloadCiphertext").lean(); expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows[0].payload)).not.toContain(access.token); const mail = JSON.parse(decryptField(rows[0].sensitivePayloadCiphertext!)); expect(mail.to).toBe("supplier@example.test"); expect(mail.text).toContain(`https://ekavyu.example.test/supplier-order#${access.token}`);
  expect(result.body).not.toContain(access.token); expect(result.body).not.toContain("Ciphertext"); expect((await PharmacyPurchaseOrder.findById(order.id))!.state).toBe("submitted");
});

it("fails closed for revoked staff permissions, disabled branches and unavailable email configuration", async () => {
  const f = await fixture(), order = await sent(f), access = await issue(f, order); vi.stubEnv("SMTP_HOST", "");
  expect((await post(f, `purchase-orders/${order.id}/supplier-email`, { locationId: f.locationId, expectedRevision: 2, confirmed: true })).statusCode).toBe(503);
  await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: [] } }); expect((await get(f, `purchase-orders/${order.id}/collaboration?locationId=${f.locationId}`)).statusCode).toBe(403);
  await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": false } }); expect((await publicPost("read", access.token)).statusCode).toBe(404);
});

it("does not queue a supplier capability email with a localhost deployment even when SMTP is configured", async () => {
  vi.stubEnv("SMTP_HOST", "smtp.example.test"); vi.stubEnv("SMTP_USER", "synthetic"); vi.stubEnv("SMTP_PASS", "synthetic"); vi.stubEnv("APP_URL", "http://localhost:3000");
  const f = await fixture(), order = await sent(f); await issue(f, order);
  const view = await get(f, `purchase-orders/${order.id}/collaboration?locationId=${f.locationId}`); expect(view.json().data.emailAvailable).toBe(false);
  const requestKey = key(), sentEmail = await post(f, `purchase-orders/${order.id}/supplier-email`, { locationId: f.locationId, expectedRevision: 2, confirmed: true }, requestKey);
  expect(sentEmail.statusCode, sentEmail.body).toBe(503); expect(await OutboundMessage.countDocuments({ idempotencyKey: `pharmacy-supplier-email:${order.id}:${requestKey}` })).toBe(0);
});

it("provides supplier financial event history without exposing other parties or allowing public finance access", async () => {
  const f = await fixture(), other = await fixture(), order = await sent(f), access = await issue(f, order);
  await PharmacyCashEvent.create({ organizationId: f.organizationId, locationId: f.locationId, partyId: f.party.id, actorId: f.user.id, kind: "supplier_credit", direction: "none", amountPaise: 100, currency: "INR", paymentMethod: "none", referenceNumber: "ACTUAL-CREDIT", normalizedReference: "actual-credit", financialYear: "2026-27", reviewReference: "Synthetic actual credit note", evidenceMode: "staff_confirmed_manual", operationKey: key(), recordedAt: new Date(), allocations: [{ purchaseReturnId: new mongoose.Types.ObjectId(), amountPaise: 100 }] });
  const events = await get(f, `suppliers/${f.party.id}/archive?locationId=${f.locationId}&section=events`); expect(events.statusCode, events.body).toBe(200); expect(events.json().data.items[0]).toMatchObject({ kind: "supplier_credit", referenceNumber: "ACTUAL-CREDIT", amountPaise: 100 });
  expect((await get(other, `suppliers/${f.party.id}/archive?locationId=${other.locationId}&section=events`)).statusCode).toBe(404);
  expect((await publicPost("read", access.token, { section: "events" })).statusCode).toBe(400);
});

it("shows actual billed and partial receiving progress to the supplier while stock changes only through the receiver", async () => {
  const f = await fixture(), order = await sent(f), access = await issue(f, order);
  const accepted = await publicPost("respond", access.token, { input: { action: "respond", expectedRevision: 2, reference: "Only four actually available", confirmed: true, lines: [{ lineId: order.lines[0].lineId, acceptedQuantity: 4 }] } }); expect(accepted.statusCode, accepted.body).toBe(200);
  const posted = await post(f, `purchases/${f.purchase.id}/post`, { locationId: f.locationId, expectedRevision: 0, expectedSupplierRevision: 0, supplierStateCode: "27", taxMode: "sgst", costTreatment: "exclude_tax", roundOffPaise: 0, reviewReference: "Actual supplier invoice reviewed" }); expect(posted.statusCode, posted.body).toBe(200);
  const link = await post(f, `purchase-orders/${order.id}/actions`, { locationId: f.locationId, expectedRevision: 3, action: "link_invoice", reference: "Exact invoice reviewed", confirmed: true, purchaseId: f.purchase.id, confirmVariance: false }); expect(link.statusCode, link.body).toBe(200);
  let progress = await publicPost("read", access.token); expect(progress.json().data).toMatchObject({ status: "billed", canRespond: false, quantities: [{ invoiced: 4, received: 0 }] }); expect(await MedicineBatch.countDocuments({ locationId: f.locationId })).toBe(0);
  const receipt = (revision: number, billed: number, free: number) => post(f, `purchases/${f.purchase.id}/receipts`, { locationId: f.locationId, expectedRevision: revision, deliveryReference: `DELIVERY-${key()}`, lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: billed, freeBaseUnits: free, batchNumber: "ACTUAL-BATCH", expiry: { precision: "month", value: "2099-12" } }] });
  const partial = await receipt(1, 1, 0); expect(partial.statusCode, partial.body).toBe(201); progress = await publicPost("read", access.token); expect(progress.json().data).toMatchObject({ status: "partially_received", quantities: [{ invoiced: 4, received: 1 }] });
  const final = await receipt(2, 2, 1); expect(final.statusCode, final.body).toBe(201); progress = await publicPost("read", access.token); expect(progress.json().data).toMatchObject({ status: "received", quantities: [{ invoiced: 4, received: 4 }] });
  const movements = await StockMovement.find({ locationId: f.locationId }).lean(); expect(movements.reduce((sum, row) => sum + row.quantityDelta, 0)).toBe(4); expect(movements.filter(row => row.purchaseSource?.purchaseId).every(row => String(row.purchaseSource!.purchaseId) === f.purchase.id)).toBe(true);
});

it("allows only one of two concurrent supplier responses to change the same revision", async () => {
  const f = await fixture(), order = await sent(f), access = await issue(f, order);
  const respond = (acceptedQuantity: number) => publicPost("respond", access.token, { input: { action: "respond", expectedRevision: 2, reference: `Actual accepted ${acceptedQuantity}`, confirmed: true, lines: [{ lineId: order.lines[0].lineId, acceptedQuantity }] } });
  const responses = await Promise.all([respond(3), respond(7)]); expect(responses.map(row => row.statusCode).sort()).toEqual([200, 409]); expect((await PharmacyPurchaseOrder.findById(order.id))!.revision).toBe(3);
  expect(await AuditLog.countDocuments({ targetId: order.id, action: "PHARMACY_ORDER_SUPPLIER_RESPOND" })).toBe(1); expect(await StockMovement.countDocuments({ locationId: f.locationId })).toBe(0);
});

it("enforces the document bound without retaining excess files and rolls back a failed email audit", async () => {
  const f = await fixture(), order = await sent(f), access = await issue(f, order);
  await PharmacyPurchaseOrder.updateOne({ _id: order.id }, { $set: { documents: Array.from({ length: 25 }, (_, n) => ({ documentId: key(), name: `retained-${n}.pdf`, kind: "invoice", contentType: "application/pdf", size: 10, objectKey: `tenants/retained/${n}`, sha256: String(n), source: "staff", supplierVisible: false, createdAt: new Date() })) } });
  const excess = await publicPost("documents", access.token, file()); expect(excess.statusCode, excess.body).toBe(409); expect((await PharmacyPurchaseOrder.findById(order.id))!.documents).toHaveLength(25); expect(storage.put).not.toHaveBeenCalled(); expect(storage.remove).not.toHaveBeenCalled();
  vi.stubEnv("SMTP_HOST", "smtp.example.test"); vi.stubEnv("SMTP_USER", "synthetic"); vi.stubEnv("SMTP_PASS", "synthetic"); vi.stubEnv("APP_URL", "https://ekavyu.example.test"); await PharmacyParty.updateOne({ _id: f.party.id }, { $set: { email: "supplier@example.test" } });
  vi.spyOn(AuditLog, "create").mockRejectedValueOnce(Error("Audit unavailable")); const requestKey = key();
  const failed = await post(f, `purchase-orders/${order.id}/supplier-email`, { locationId: f.locationId, expectedRevision: 2, confirmed: true }, requestKey); expect(failed.statusCode, failed.body).toBe(503);
  expect(await OutboundMessage.countDocuments({ idempotencyKey: `pharmacy-supplier-email:${order.id}:${requestKey}` })).toBe(0); expect((await PharmacyPurchaseOrder.findById(order.id))!.supplierEmail).toBeUndefined();
});

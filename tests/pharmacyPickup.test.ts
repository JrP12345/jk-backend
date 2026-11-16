import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { publicSlug } from "../utilities/publicLinks.ts";
import { Location } from "../models/Location.ts";
import { Medicine } from "../models/Medicine.ts";
import { PharmacyPickup } from "../models/PharmacyPickup.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";

beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
async function fixture() {
  const f = await pharmacyRetailFixture(["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_MANAGE_SETTINGS"]);
  await Location.updateOne({ _id: f.locationId }, { $set: { facilityType: "pharmacy", isPublished: true } });
  const slug = await publicSlug("location", f.locationId, "Synthetic pharmacy");
  return { ...f, slug, token: crypto.randomBytes(32).toString("hex") };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const publish = (f: Fixture, catalogueEnabled = true, pickupEnabled = true, expectedRevision = 0) => app.inject({ method: "PUT", url: `/api/pharmacy/locations/${f.locationId}/storefront`, headers: f.headers, payload: { catalogueEnabled, pickupEnabled, expectedRevision } });
const input = (f: Fixture) => ({ name: "Synthetic customer", phone: "+919999000001", ticketSecret: f.token, items: [{ medicineId: f.medicine.id, quantity: 2, unitVersion: 1 }] });
const request = (f: Fixture, payload = input(f), key = crypto.randomUUID()) => app.inject({ method: "POST", url: `/api/public/locations/${f.slug}/pickups`, headers: { "idempotency-key": key }, payload });
const status = (f: Fixture) => app.inject({ method: "POST", url: "/api/public/pharmacy-pickup/status", payload: { token: f.token } });
const scan = (f: Fixture, ticket: string) => app.inject({ method: "POST", url: "/api/pharmacy/pickups/scan", headers: f.headers, payload: { locationId: f.locationId, ticket } });
const transition = (f: Fixture, id: string, action: string, revision: number, invoiceNumber?: string, key = crypto.randomUUID()) => app.inject({ method: "POST", url: `/api/pharmacy/pickups/${id}/transition`, headers: { ...f.headers, "idempotency-key": key }, payload: { locationId: f.locationId, expectedRevision: revision, action, ...(invoiceNumber ? { invoiceNumber } : {}) } });
async function sale(f: Fixture, paid = true) {
  const quote = await app.inject({ method: "POST", url: "/api/pharmacy/sales/quote", headers: f.headers, payload: { locationId: f.locationId, lines: f.input.lines.map(({ expectedStockRevision: _stock, ...line }) => line) } });
  expect(quote.statusCode, quote.body).toBe(200);
  const result = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": crypto.randomUUID() }, payload: { ...quote.json().data.issueInput, ...(paid ? { payment: { locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 2000, entries: [{ componentId: crypto.randomUUID(), amountPaise: 2000, paymentMethod: "cash" }] } } : {}) } });
  expect(result.statusCode, result.body).toBe(201); return result.json().data;
}

it("keeps doctorless pharmacies in browse and makes catalogue and pickup independently opt-in", async () => {
  const f = await fixture();
  const profile = await app.inject({ method: "GET", url: `/api/public/locations/${f.slug}` });
  expect(profile.statusCode, profile.body).toBe(200);
  expect(profile.json().data).toMatchObject({ facilityType: "pharmacy", doctors: [], pharmacy: { catalogueEnabled: false, pickupEnabled: false } });
  const browse = await app.inject({ method: "GET", url: "/api/public/locations?facilityType=pharmacy" });
  expect(browse.json().data.some((row: { id: string }) => row.id === f.locationId)).toBe(true);
  expect((await app.inject({ method: "GET", url: `/api/public/locations/${f.slug}/medicines` })).statusCode).toBe(404);
  expect((await publish(f, false, true)).statusCode).toBe(400);
  const published = await publish(f, true, false); expect(published.statusCode, published.body).toBe(200);
  const catalogue = await app.inject({ method: "GET", url: `/api/public/locations/${f.slug}/medicines` });
  expect(catalogue.statusCode, catalogue.body).toBe(200);
  expect(catalogue.json().data).toMatchObject({ catalogueEnabled: true, pickupEnabled: false, items: [{ id: f.medicine.id, available: true, baseUnit: "tablet" }] });
  for (const field of ["price", "stockQuantity", "purchasePrice", "barcodes", "dispensingReview"]) expect(catalogue.body).not.toContain(`"${field}"`);
  expect((await request(f)).statusCode).toBe(409);
  expect((await publish(f, true, true, 0)).statusCode).toBe(409);
  expect((await publish(f, true, true, 1)).statusCode).toBe(200);
  expect((await request(f)).statusCode).toBe(201);
});

it("creates one encrypted non-reserving request and keeps its ticket private and retryable after unpublishing", async () => {
  const f = await fixture(); expect((await publish(f)).statusCode).toBe(200);
  const key = crypto.randomUUID(), replies = await Promise.all([request(f, input(f), key), request(f, input(f), key)]);
  expect(replies.map(row => row.statusCode), replies.map(row => row.body).join("\n")).toEqual([201, 201]);
  const ticket = replies[0].json().data;
  expect(replies[1].json().data.id).toBe(ticket.id);
  expect(await PharmacyPickup.countDocuments({ locationId: f.locationId })).toBe(1);
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  expect(await Invoice.countDocuments({ locationId: f.locationId })).toBe(0);
  const stored = await PharmacyPickup.findById(ticket.id).select("+customerNameCiphertext +phoneCiphertext +tokenHash").lean();
  expect(stored!.phoneCiphertext).not.toContain("9999000001"); expect(stored!.customerNameCiphertext).not.toContain("Synthetic customer"); expect(stored!.tokenHash).not.toBe(f.token);
  const publicRead = await status(f); expect(publicRead.statusCode, publicRead.body).toBe(200);
  for (const field of ["customerName", "phoneCiphertext", "customerNameCiphertext", "phoneHash", "tokenHash", "invoiceId"]) expect(publicRead.body).not.toContain(`"${field}"`);
  expect((await scan(f, f.token)).json().data).toMatchObject({ customerName: "Synthetic customer", phone: "+919999000001" });
  expect((await request(f, { ...input(f), name: "Changed" }, key)).statusCode).toBe(409);
  expect((await publish(f, false, false, 1)).statusCode).toBe(200);
  expect((await status(f)).json().data.status).toBe("requested");
  expect((await request(f, input(f), key)).statusCode).toBe(201);
  expect((await request({ ...f, token: crypto.randomBytes(32).toString("hex") })).statusCode).toBe(404);
  expect((await status({ ...f, token: crypto.randomBytes(32).toString("hex") })).statusCode).toBe(404);
});

it("rejects stale units, excess stock, hidden, unreviewed and restricted products without creating requests", async () => {
  const f = await fixture(); await publish(f);
  for (const items of [[{ ...input(f).items[0], quantity: 11 }], [{ ...input(f).items[0], unitVersion: 2 }], [{ ...input(f).items[0], quantity: 0 }], [input(f).items[0], input(f).items[0]]]) expect([400, 409]).toContain((await request(f, { ...input(f), items })).statusCode);
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { scheduleType: "H" } });
  expect((await app.inject({ method: "GET", url: `/api/public/locations/${f.slug}/medicines` })).json().data.items).toEqual([]);
  expect((await request(f)).statusCode).toBe(409);
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { scheduleType: "general", dispensingRevision: 0 } });
  expect((await request(f)).statusCode).toBe(409);
  await Location.updateOne({ _id: f.locationId }, { $set: { isPublished: false } });
  expect((await request(f)).statusCode).toBe(404);
  expect(await PharmacyPickup.countDocuments({ locationId: f.locationId })).toBe(0);
});

it("links the exact paid counter bill and allows only one recorded QR handover without deducting stock again", async () => {
  const f = await fixture(); await publish(f);
  const requested = await request(f), pickup = requested.json().data; expect(requested.statusCode, requested.body).toBe(201);
  expect((await transition(f, pickup.id, "collect", 0)).statusCode).toBe(409);
  const bill = await sale(f);
  const prepared = await transition(f, pickup.id, "ready", 0, bill.invoiceNumber); expect(prepared.statusCode, prepared.body).toBe(200);
  expect(prepared.json().data).toMatchObject({ status: "ready", invoiceId: bill.invoiceId, revision: 1 });
  expect((await status(f)).json().data.status).toBe("ready");
  const key = crypto.randomUUID(), done = await transition(f, pickup.id, "collect", 1, undefined, key); expect(done.statusCode, done.body).toBe(200);
  expect((await transition(f, pickup.id, "collect", 1, undefined, key)).json().data).toMatchObject({ status: "collected", revision: 2 });
  expect((await transition(f, pickup.id, "collect", 1)).statusCode).toBe(409);
  expect((await scan(f, pickup.reference)).json().data.status).toBe("collected");
  expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  expect(await AuditLog.countDocuments({ targetId: pickup.id, action: "PHARMACY_PICKUP_COLLECT" })).toBe(1);
});

it("blocks unpaid handover, foreign branches, expired tickets and staff without counter permission", async () => {
  const f = await fixture(); await publish(f); const pickup = (await request(f)).json().data;
  const bill = await sale(f, false), ready = await transition(f, pickup.id, "ready", 0, bill.invoiceNumber); expect(ready.statusCode, ready.body).toBe(200);
  expect((await transition(f, pickup.id, "collect", 1)).statusCode).toBe(409);
  const foreign = await fixture(); expect((await scan(foreign, f.token)).statusCode).toBe(404);
  expect((await transition(foreign, pickup.id, "collect", 1)).statusCode).toBe(404);
  const cashier = await pharmacyRetailFixture(["PHARMACY_COLLECT_PAYMENT"]);
  expect((await transition({ ...f, headers: cashier.headers, locationId: cashier.locationId }, pickup.id, "collect", 1)).statusCode).toBe(403);
  await PharmacyPickup.collection.updateOne({ _id: new mongoose.Types.ObjectId(pickup.id) }, { $set: { expiresAt: new Date(0) } });
  expect((await status(f)).json().data.status).toBe("expired");
  expect((await transition(f, pickup.id, "collect", 1)).statusCode).toBe(409);
  expect((await transition(f, pickup.id, "cancel", 1)).json().data.status).toBe("cancelled");
});

it("rolls back preparation when the required audit fails and rejects publication by a foreign owner", async () => {
  const f = await fixture(); await publish(f); const pickup = (await request(f)).json().data, bill = await sale(f);
  const audit = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(Error("Synthetic audit failure"));
  try { expect((await transition(f, pickup.id, "ready", 0, bill.invoiceNumber)).statusCode).toBe(500); } finally { audit.mockRestore(); }
  expect((await status(f)).json().data).toMatchObject({ status: "requested", revision: 0 });
  const foreign = await fixture(); expect([403, 404]).toContain((await publish({ ...f, headers: foreign.headers }, false, false, 1)).statusCode);
  expect((await transition(f, pickup.id, "ready", 0, bill.invoiceNumber)).statusCode).toBe(200);
});

it("never reuses a parcel's bill and rejects changed classification or expired billed batches", async () => {
  const f = await fixture(); await publish(f);
  const first = (await request(f)).json().data;
  const second = (await request({ ...f, token: crypto.randomBytes(32).toString("hex") })).json().data;
  const bill = await sale(f);
  expect((await transition(f, first.id, "ready", 0, bill.invoiceNumber)).statusCode).toBe(200);
  expect((await transition(f, second.id, "ready", 0, bill.invoiceNumber)).statusCode).toBe(409);
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { dispensingRevision: 0 } });
  expect((await transition(f, first.id, "collect", 1)).statusCode).toBe(409);
  await Medicine.updateOne({ _id: f.medicine.id }, { $set: { dispensingRevision: 1 } });
  await PharmacyDispense.collection.updateOne({ invoiceId: new mongoose.Types.ObjectId(bill.invoiceId) }, { $set: { "lines.0.pricingAllocations.0.expiryDate": new Date(0) } });
  expect((await transition(f, first.id, "collect", 1)).statusCode).toBe(409);
  expect((await scan(f, f.token)).json().data.status).toBe("ready");
  expect((await app.inject({ method: "POST", url: "/api/pharmacy/pickups/scan", payload: { locationId: f.locationId, ticket: f.token } })).statusCode).toBe(401);
});

it("can publish a simple list before billing setup, but requires a reviewed issuer before accepting parcels", async () => {
  const f = await fixture(); await PharmacyTaxProfile.deleteOne({ locationId: f.locationId });
  expect((await publish(f, true, false)).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: `/api/public/locations/${f.slug}/medicines` })).statusCode).toBe(200);
  expect((await publish(f, true, true, 1)).statusCode).toBe(409);
});

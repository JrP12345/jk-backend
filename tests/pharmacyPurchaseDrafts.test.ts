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
import { StockMovement } from "../models/StockMovement.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { Invoice } from "../models/Invoice.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { createAuthSession } from "../utilities/helpers.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
async function fixture(permissions = ["PHARMACY_PURCHASE"]) {
  const organizationId = (await Organization.create({ name: "Synthetic purchaser", city: "Pune", countryCode: "IN", currency: "INR" })).id;
  const locationId = (await Location.create({ organizationId, name: "Purchase branch", city: "Pune" })).id;
  const role = `purchaser_${key()}`; await Role.create({ name: role, organizationId, permissions });
  const user = await User.create({ name: "Purchaser", email: `${key()}@example.test`, role });
  await OrgMember.create({ organizationId, userId: user.id, role, locationAccess: { mode: "selected", locationIds: [locationId] } });
  const session = await createAuthSession({ id: user.id, role, email: user.email!, organization_id: organizationId });
  const medicine = await Medicine.create({ locationId, name: "Purchase product", genericName: "Synthetic", price: 10, stockQuantity: 0, costPrice: 99, unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } });
  const party = { locationId, locationIds: [locationId], name: "Synthetic supplier", kinds: ["supplier"], address: "Synthetic business address", phone: "9000000000", email: "supplier@example.test", gstRegistration: "unregistered", licence: { number: "ACTUAL-TEST-LICENCE", validUntil: "2099-12-31" }, archived: false };
  return { organizationId, locationId, user, role, medicine, party, headers: { authorization: `Bearer ${session.accessToken}` } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, path: string, body: object, requestKey = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": requestKey }, payload: body });
const put = (f: Fixture, path: string, body: object) => app.inject({ method: "PUT", url: `/api/pharmacy/${path}`, headers: f.headers, payload: body });
const get = (f: Fixture, path: string, query = "") => app.inject({ method: "GET", url: `/api/pharmacy/${path}?locationId=${f.locationId}${query}`, headers: f.headers });
async function supplier(f: Fixture) { const response = await post(f, "parties", f.party); expect(response.statusCode, response.body).toBe(201); return response.json().data; }
function draft(f: Fixture, supplierId: string) { return { locationId: f.locationId, supplierId, expectedSupplierRevision: 0, supplierInvoiceNumber: `INV-${key()}`, invoiceDate: "2026-10-20", statedTotalPaise: 12345, notes: "Original supplier invoice details",
  lines: [{ lineId: key(), medicineId: f.medicine.id, expectedUnitVersion: 1, packs: 2, looseUnits: 1, freePacks: 1, freeLooseUnits: 0, baseAmountPaise: 12345, discountPaise: 0, gstRateBps: 0, hsnCode: "300490", sellingPricePaise: 1000, mrpPaise: 1200 }] }; }

describe("Pharmacy parties and purchase drafts", () => {
  it("persists server-calculated discounted GST totals, retains a stated mismatch and refreshes only on save", async () => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id);
    body.statedTotalPaise = 12000; body.lines[0].baseAmountPaise = 12000; body.lines[0].discountPaise = 2000; body.lines[0].gstRateBps = 1800;
    const saved = await post(f, "purchases", body); expect(saved.statusCode, saved.body).toBe(201);
    const value = saved.json().data;
    expect(value.calculation).toMatchObject({ policy: "pharmacy-paise-v2", currency: "INR", priceMode: "exclusive", taxMode: "unallocated",
      lines: [{ lineId: body.lines[0].lineId, quantity: 31, amountBeforeDiscountPaise: 12000, lineDiscountPaise: 2000, baseAmountPaise: 10000, unallocatedTaxPaise: 1800, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 }],
      totals: { baseAmountPaise: 10000, unallocatedTaxPaise: 1800, payablePaise: 11800, roundOffPaise: 0 } });
    expect(value.statedTotalPaise).toBe(12000);
    expect((await get(f, `purchases/${value.id}`)).json().data.calculation).toEqual(value.calculation);
    expect((await post(f, "purchases", { ...body, supplierInvoiceNumber: "INJECTED", calculation: value.calculation })).statusCode).toBe(400);
    body.lines[0].discountPaise = 3000;
    const changed = await put(f, `purchases/${value.id}`, { ...body, expectedRevision: 0 }); expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().data.calculation.totals).toMatchObject({ baseAmountPaise: 9000, unallocatedTaxPaise: 1620, payablePaise: 10620 });
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("does not recalculate an older draft on read or same-key replay, and captures a version on explicit save", async () => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id), requestKey = key();
    const saved = (await post(f, "purchases", body, requestKey)).json().data;
    await PharmacyPurchase.updateOne({ _id: saved.id }, { $unset: { calculation: 1 } }); // Synthetic pre-T16 record.
    expect((await get(f, `purchases/${saved.id}`)).json().data).not.toHaveProperty("calculation");
    expect((await post(f, "purchases", body, requestKey)).json().data).not.toHaveProperty("calculation");
    expect((await PharmacyPurchase.findById(saved.id))!.calculation).toBeUndefined();
    const changed = await put(f, `purchases/${saved.id}`, { ...body, expectedRevision: 0 }); expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().data.calculation.totals).toMatchObject({ unallocatedTaxPaise: 0, payablePaise: 12345 });
  });
  it("saves and reopens exact draft quantities, free goods, unit and supplier snapshots without posting stock or money", async () => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id), response = await post(f, "purchases", body);
    expect(response.statusCode, response.body).toBe(201); expect(response.headers["cache-control"]).toBe("no-store");
    const saved = response.json().data, read = await get(f, `purchases/${saved.id}`);
    expect(read.json().data).toMatchObject({ status: "draft", revision: 0, statedTotalPaise: 12345, currency: "INR", invoiceFY: "2026-2027", supplierSnapshot: { name: f.party.name, address: f.party.address, revision: 0 },
      lines: [{ lineId: body.lines[0].lineId, billedBaseUnits: 21, freeBaseUnits: 10, baseAmountPaise: 12345, gstRateBps: 0, discountPaise: 0, unitSnapshot: { version: 1, unitsPerPack: 10 }, medicineSnapshot: { name: f.medicine.name } }] });
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0);
    expect(await MedicineBatch.countDocuments({ medicineId: f.medicine.id })).toBe(0); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(0);
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect(read.json().data).not.toHaveProperty("amountPaid"); expect(read.json().data).not.toHaveProperty("patientId");
  });
  it("supports one party in both roles, optional GST and a stable GST identity after archive", async () => {
    const f = await fixture(), response = await post(f, "parties", { ...f.party, kinds: ["supplier", "customer"], gstRegistration: "registered", gstin: "27ABCDE1234F1Z5" });
    expect(response.statusCode, response.body).toBe(201); const party = response.json().data;
    const archived = await put(f, `parties/${party.id}`, { ...f.party, kinds: party.kinds, gstRegistration: "registered", gstin: party.gstin, archived: true, expectedRevision: 0 });
    expect(archived.statusCode, archived.body).toBe(200); expect((await get(f, "parties")).json().data.items).toEqual([]);
    expect((await get(f, "parties", "&archived=true")).json().data.items[0].id).toBe(party.id);
    expect((await post(f, "parties", { ...f.party, gstRegistration: "registered", gstin: party.gstin })).statusCode).toBe(409);
    expect((await post(f, "parties", { ...f.party, name: "Unregistered supplier one" })).statusCode).toBe(201);
    expect((await post(f, "parties", { ...f.party, name: "Unregistered supplier two" })).statusCode).toBe(201);
  });
  it("does not require supplier licensing for an ordinary customer", async () => {
    const f = await fixture(), { licence: _licence, ...fields } = f.party;
    const response = await post(f, "parties", { ...fields, kinds: ["customer"] });
    expect(response.statusCode, response.body).toBe(201); expect(response.json().data).not.toHaveProperty("licence");
    expect((await post(f, "purchases", draft(f, response.json().data.id))).statusCode).toBe(409);
  });
  it("retains a registered supplier's tax identity once linked to purchase history", async () => {
    const f = await fixture(), registered = { ...f.party, gstRegistration: "registered", gstin: "27ABCDE1234F1Z5" };
    const party = (await post(f, "parties", registered)).json().data;
    expect((await post(f, "purchases", draft(f, party.id))).statusCode).toBe(201);
    const changed = await put(f, `parties/${party.id}`, { ...f.party, expectedRevision: 0 });
    expect(changed.statusCode, changed.body).toBe(409); expect(changed.json().message).toMatch(/GST identity/);
    expect((await put(f, `parties/${party.id}`, { ...registered, name: "New trading name", archived: true, expectedRevision: 0 })).statusCode).toBe(200);
  });
  it("preserves the original supplier snapshot after rename and archive", async () => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id), saved = (await post(f, "purchases", body)).json().data;
    expect((await put(f, `parties/${party.id}`, { ...f.party, name: "Renamed supplier", address: "New address", expectedRevision: 0 })).statusCode).toBe(200);
    const edited = await put(f, `purchases/${saved.id}`, { ...body, notes: "Updated draft note", expectedRevision: 0, expectedSupplierRevision: 1 });
    expect(edited.statusCode, edited.body).toBe(200); expect(edited.json().data.supplierSnapshot.name).toBe(f.party.name);
    expect((await put(f, `parties/${party.id}`, { ...f.party, name: "Renamed supplier", archived: true, expectedRevision: 1 })).statusCode).toBe(200);
    expect((await get(f, `purchases/${saved.id}`)).json().data.supplierSnapshot.name).toBe(f.party.name);
    expect((await post(f, "purchases", { ...body, supplierInvoiceNumber: "NEW-BILL", expectedSupplierRevision: 2 })).statusCode).toBe(409);
  });
  it("enforces stale revision and concurrent edit protection for both masters and drafts", async () => {
    const f = await fixture(), party = await supplier(f);
    const edits = await Promise.all([put(f, `parties/${party.id}`, { ...f.party, name: "Edit A", expectedRevision: 0 }), put(f, `parties/${party.id}`, { ...f.party, name: "Edit B", expectedRevision: 0 })]);
    expect(edits.map(row => row.statusCode).sort()).toEqual([200, 409]);
    const body = { ...draft(f, party.id), expectedSupplierRevision: 1 }, saved = (await post(f, "purchases", body)).json().data;
    const draftEdits = await Promise.all([put(f, `purchases/${saved.id}`, { ...body, expectedRevision: 0, notes: "Edit A" }), put(f, `purchases/${saved.id}`, { ...body, expectedRevision: 0, notes: "Edit B" })]);
    expect(draftEdits.map(row => row.statusCode).sort()).toEqual([200, 409]); expect((await get(f, `purchases/${saved.id}`)).json().data.revision).toBe(1);
  });
  it("replays creation under the same key and prevents duplicate supplier invoices under new keys", async () => {
    const f = await fixture(), partyKey = key();
    const parties = await Promise.all([post(f, "parties", f.party, partyKey), post(f, "parties", f.party, partyKey)]);
    expect(parties.map(row => row.statusCode)).toEqual([201, 201]); expect(new Set(parties.map(row => row.json().data.id)).size).toBe(1);
    const body = { ...draft(f, parties[0].json().data.id), supplierInvoiceNumber: " AB / 001 " }, draftKey = key();
    const saves = await Promise.all([post(f, "purchases", body, draftKey), post(f, "purchases", body, draftKey)]);
    expect(saves.map(row => row.statusCode)).toEqual([201, 201]); expect(new Set(saves.map(row => row.json().data.id)).size).toBe(1);
    expect((await post(f, "purchases", { ...body, supplierInvoiceNumber: "ab/001" })).statusCode).toBe(409);
    expect((await post(f, "purchases", { ...body, statedTotalPaise: 1 }, draftKey)).statusCode).toBe(409);
    expect((await post(f, "purchases", { ...body, invoiceDate: "2027-04-01" })).statusCode).toBe(201);
  });
  it("keeps source identity unique across branches and protects shared party edits", async () => {
    const f = await fixture(), party = await supplier(f), second = await Location.create({ organizationId: f.organizationId, name: "Other branch", city: "Pune" });
    await OrgMember.updateOne({ userId: f.user.id, organizationId: f.organizationId }, { $set: { locationAccess: { mode: "all", locationIds: [] } } });
    expect((await put(f, `parties/${party.id}`, { ...f.party, locationIds: [f.locationId, second.id], expectedRevision: 0 })).statusCode).toBe(200);
    const otherMedicine = await Medicine.create({ locationId: second.id, name: "Other branch medicine", genericName: "Synthetic", price: 10, stockQuantity: 0, unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } });
    const body = { ...draft(f, party.id), expectedSupplierRevision: 1 }; expect((await post(f, "purchases", body)).statusCode).toBe(201);
    const repeated = await post(f, "purchases", { ...body, locationId: second.id, lines: [{ ...body.lines[0], medicineId: otherMedicine.id }] });
    expect(repeated.statusCode, repeated.body).toBe(409); expect(repeated.body).not.toContain(second.id);
    await OrgMember.updateOne({ userId: f.user.id, organizationId: f.organizationId }, { $set: { locationAccess: { mode: "selected", locationIds: [f.locationId] } } });
    expect((await put(f, `parties/${party.id}`, { ...f.party, locationIds: [f.locationId, second.id], expectedRevision: 1 })).statusCode).toBe(404);
  });
  it("preserves unique GST and invoice identities even before the new indexes are prepared", async () => {
    // This test only changes indexes in its disposable MongoMemoryReplSet database.
    expect(process.env.NODE_ENV).toBe("test");
    const gst = (await PharmacyParty.collection.listIndexes().toArray()).find(index => index.unique && index.key.gstin === 1)!;
    const invoice = (await PharmacyPurchase.collection.listIndexes().toArray()).find(index => index.unique && index.key.normalizedInvoiceNumber === 1)!;
    await PharmacyParty.collection.dropIndex(gst.name); await PharmacyPurchase.collection.dropIndex(invoice.name);
    try {
      const f = await fixture(), body = { ...f.party, gstRegistration: "registered", gstin: "27FGHIJ5678K1Z5" };
      const parties = await Promise.all([post(f, "parties", body), post(f, "parties", body)]);
      expect(parties.map(row => row.statusCode).sort()).toEqual([201, 409]);
      const partyId = parties.find(row => row.statusCode === 201)!.json().data.id, purchase = draft(f, partyId);
      const purchases = await Promise.all([post(f, "purchases", purchase), post(f, "purchases", purchase)]);
      expect(purchases.map(row => row.statusCode).sort()).toEqual([201, 409]);
      expect(await PharmacyPurchase.countDocuments({ organizationId: f.organizationId })).toBe(1);
    } finally { await PharmacyParty.createIndexes(); await PharmacyPurchase.createIndexes(); }
  });
  it("denies cost reads to stock-only staff and consumer roles, and respects revocation and tenant assertions", async () => {
    const f = await fixture(), party = await supplier(f), saved = (await post(f, "purchases", draft(f, party.id))).json().data, other = await fixture(["MANAGE_MEDICINES"]);
    expect((await get(other, "purchases")).statusCode).toBe(403); expect((await get(other, "parties")).statusCode).toBe(403);
    expect((await get(f, "purchases", `&organizationId=${other.organizationId}`)).statusCode).toBe(403);
    expect((await post(f, "purchases", { ...draft(f, party.id), organization_id: other.organizationId })).statusCode).toBe(403);
    expect((await get(f, `purchases/${saved.id}`, `&locationId=${other.locationId}`)).statusCode).toBe(400);
    const patient = await User.create({ name: "Consumer", email: `${key()}@example.test`, role: "patient" }), session = await createAuthSession({ id: patient.id, role: "patient", email: patient.email!, organization_id: f.organizationId });
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/purchases?locationId=${f.locationId}`, headers: { authorization: `Bearer ${session.accessToken}` } })).statusCode).toBe(403);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: [] } });
    expect((await get(f, `purchases/${saved.id}`)).statusCode).toBe(403);
  });
  it("supports purchase-only product lookup without stock, acquisition cost or clinical grants", async () => {
    const f = await fixture();
    const response = await get(f, "purchase-products"); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.items[0]).toMatchObject({ id: f.medicine.id, name: f.medicine.name, unitDefinition: { unitsPerPack: 10 } });
    expect(response.json().data.items[0]).not.toHaveProperty("stockQuantity"); expect(response.json().data.items[0]).not.toHaveProperty("costPrice");
    expect((await app.inject({ method: "GET", url: `/api/medicines?locationId=${f.locationId}`, headers: f.headers })).statusCode).toBe(403);
    const capability = await app.inject({ method: "GET", url: `/api/pharmacy/locations/${f.locationId}/capabilities`, headers: f.headers });
    expect(capability.json().data.actions).toMatchObject({ viewPurchases: true, managePurchases: true, viewStock: false });
  });
  it("keeps draft history readable after pharmacy disable, while writes and module-disabled access are denied", async () => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id), saved = (await post(f, "purchases", body)).json().data;
    await Location.updateOne({ _id: f.locationId }, { $set: { pharmacyCapability: { enabled: false, revision: 1 } } });
    expect((await get(f, `purchases/${saved.id}`)).statusCode).toBe(200); expect((await post(f, "purchases", body)).statusCode).toBe(409);
    await ModuleRegistry.create({ organizationId: f.organizationId, moduleKey: "pharmacy", enabled: false, priority: "P1", label: "Pharmacy" });
    expect((await get(f, "purchases")).statusCode).toBe(403);
  });
  it.each([
    { baseAmountPaise: "123" }, { baseAmountPaise: null }, { packs: "2" }, { packs: Number.MAX_SAFE_INTEGER }, { looseUnits: 10 }, { freeLooseUnits: -1 },
    { expectedUnitVersion: 2 }, { discountPaise: 12346 }, { gstRateBps: 10001 }, { hsnCode: "999" }, { sellingPricePaise: 1201 },
  ])("rejects unsafe draft line %j", async fields => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id);
    const response = await post(f, "purchases", { ...body, lines: [{ ...body.lines[0], ...fields }] });
    expect([400, 409]).toContain(response.statusCode); expect(await PharmacyPurchase.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("rejects foreign/deleted products, repeated line IDs, malformed dates and forged posting fields", async () => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id), foreign = await fixture();
    expect((await post(f, "purchases", { ...body, lines: [{ ...body.lines[0], medicineId: foreign.medicine.id }] })).statusCode).toBe(409);
    expect((await post(f, "purchases", { ...body, lines: [body.lines[0], body.lines[0]] })).statusCode).toBe(400);
    expect((await post(f, "purchases", { ...body, invoiceDate: "2027-02-29" })).statusCode).toBe(400);
    expect((await post(f, "purchases", { ...body, supplierInvoiceNumber: "INV\u200B-001" })).statusCode).toBe(400);
    expect((await post(f, "purchases", { ...body, status: "posted", amountPaid: 12345 })).statusCode).toBe(400);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { deletedAt: new Date() } });
    expect((await post(f, "purchases", body)).statusCode).toBe(409);
  });
  it("validates supplier licence, registration and stale supplier revisions", async () => {
    const f = await fixture();
    expect((await post(f, "parties", { ...f.party, licence: { number: "X", validUntil: "2099-02-30" } })).statusCode).toBe(400);
    expect((await post(f, "parties", { ...f.party, gstRegistration: "registered", gstin: "bad" })).statusCode).toBe(400);
    const party = (await post(f, "parties", { ...f.party, licence: { number: "EXPIRED", validUntil: "2000-01-01" } })).json().data;
    expect((await post(f, "purchases", draft(f, party.id))).statusCode).toBe(409);
    await put(f, `parties/${party.id}`, { ...f.party, expectedRevision: 0 });
    expect((await post(f, "purchases", draft(f, party.id))).statusCode).toBe(409);
  });
  it("captures an unposted draft without fabricating an unrecorded licence expiry or approval", async () => {
    const f = await fixture(), party = (await post(f, "parties", { ...f.party, licence: { number: "ACTUAL-RECORDED-LICENCE" } })).json().data;
    const saved = await post(f, "purchases", draft(f, party.id)); expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json().data.supplierSnapshot.licence).toEqual({ number: "ACTUAL-RECORDED-LICENCE" });
    expect(saved.json().data.supplierSnapshot).not.toHaveProperty("licenceApproved"); expect(saved.json().data.status).toBe("draft");
  });
  it("bounds list pages, escapes search and preserves leading-zero product aliases", async () => {
    const f = await fixture();
    await PharmacyParty.insertMany(Array.from({ length: 4 }, (_, index) => ({ ...f.party, organizationId: f.organizationId, name: `Supplier ${index}`, normalizedName: `supplier ${index}`, createdBy: f.user.id, updatedBy: f.user.id })));
    const first = await get(f, "parties", "&limit=2"), cursor = first.json().data.nextCursor;
    expect(first.json().data.items).toHaveLength(2); expect(cursor).toBeTruthy();
    const second = await get(f, "parties", `&limit=2&cursor=${cursor}`); expect(second.json().data.items).toHaveLength(2); expect(second.json().data.nextCursor).toBeNull();
    expect((await get(f, "parties", "&search=%5B")).statusCode).toBe(200); expect((await get(f, "purchases", "&limit=51")).statusCode).toBe(400);
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { barcodes: ["000123"] } });
    expect((await get(f, "purchase-products", "&search=000123")).json().data.items[0].id).toBe(f.medicine.id);
    expect((await get(f, "purchase-products", "&search=123")).json().data.items).toEqual([]);
  });
  it("rolls back the draft, reservation and audit on failure, then accepts a same-key retry", async () => {
    const f = await fixture(), party = await supplier(f), body = draft(f, party.id), requestKey = key(), create = AuditLog.create.bind(AuditLog);
    const spy = vi.spyOn(AuditLog, "create").mockImplementation(((...args: any[]) => {
      const rows = Array.isArray(args[0]) ? args[0] : [args[0]];
      if (rows.some(row => row.action === "PHARMACY_PURCHASE_DRAFT_SAVED")) return Promise.reject(new Error("Synthetic required audit failure"));
      return Reflect.apply(create, AuditLog, args);
    }) as typeof AuditLog.create);
    try { expect((await post(f, "purchases", body, requestKey)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect(await PharmacyPurchase.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await OperationReceipt.countDocuments({ key: requestKey })).toBe(0);
    expect((await post(f, "purchases", body, requestKey)).statusCode).toBe(201);
  });
});

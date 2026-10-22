import { pharmacyRetailFixture as fixture } from "./helpers/pharmacyRetailFixture.ts";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Role } from "../models/Role.ts";
import { Patient } from "../models/Patient.ts";
import { Doctor } from "../models/Doctor.ts";
import { Encounter } from "../models/Encounter.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyTaxProfile } from "../models/PharmacyTaxProfile.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { pharmacyTaxFixture } from "./helpers/pharmacyTaxFixture.ts";
import { receivePharmacyStock } from "../services/PharmacyStockReceiptService.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Fixture = Awaited<ReturnType<typeof fixture>>;
const post = (f: Fixture, input: object = f.input, requestKey = key()) => app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": requestKey }, payload: input });
const get = (f: Fixture, path: string) => app.inject({ method: "GET", url: `/api/pharmacy/${path}?locationId=${f.locationId}`, headers: f.headers });
async function issued(f: Fixture) { const result = await post(f); expect(result.statusCode, result.body).toBe(201); return result.json().data; }

describe("Patient-optional counter invoices through shared Invoice/PharmacyDispense", () => {
  it("issues an anonymous ordinary invoice without Patient, Doctor or Encounter and captures real lot evidence", async () => {
    const f = await fixture(), result = await issued(f), response = await get(f, `invoices/${result.invoiceId}`), invoice = response.json().data;
    expect(response.statusCode, response.body).toBe(200); expect(response.headers["cache-control"]).toBe("no-store");
    expect(invoice).toMatchObject({ kind: "pharmacy", documentVersion: 2, createdBy: f.user.id, customerSnapshot: { anonymous: true }, status: "unpaid", amountPaid: 0, balanceDue: 20, payments: [],
      taxDocument: { version: 2, pricingPolicy: "pharmacy-paise-v2", recipient: { name: "Walk-in customer" } },
      items: [{ quantity: 2, grossAmountPaise: 2000, unitSnapshot: { baseUnit: "tablet" }, batches: [{ batchNumber: "ACTUAL-BATCH", expiryValue: "2099-12", quantity: 2, mrpPaise: 1200 }] }] });
    expect(invoice).not.toHaveProperty("patientId"); expect(invoice).not.toHaveProperty("doctorId"); expect(invoice.items[0].batches[0]).not.toHaveProperty("costBasis");
    expect(await Patient.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await Doctor.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await Encounter.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
    expect(await PharmacyDispense.findById(result.dispenseId)).toMatchObject({ kind: "pharmacy", prescriptionIds: [] });
    expect((await get(f, "invoices")).json().data.items).toHaveLength(1);
  });
  it("replays a concurrent command once, rejects changed payload, and keeps original outcome after subsequent sale", async () => {
    const f = await fixture(), requestKey = key(), responses = await Promise.all([post(f, f.input, requestKey), post(f, f.input, requestKey)]);
    expect(responses.map(result => result.statusCode)).toEqual([201, 201]); const original = responses[0].json().data;
    expect(responses[1].json().data.invoiceId).toBe(original.invoiceId);
    expect((await post(f, { ...f.input, roundOffPaise: 1 }, requestKey)).statusCode).toBe(409);
    const second = { ...f.input, lines: [{ ...f.input.lines[0], expectedStockRevision: 2 }] }; expect((await post(f, second)).statusCode).toBe(201);
    expect((await get(f, `sale-operations/${requestKey}`)).json().data).toMatchObject({ invoiceId: original.invoiceId, totalPaise: 2000 });
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(2); expect(await PharmacyDispense.countDocuments({ organizationId: f.organizationId })).toBe(2);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(6);
  });
  it("uses reviewed regular GST, line/invoice discounts and explicit round-off before committing totals", async () => {
    const f = await fixture(); await PharmacyTaxProfile.updateOne({ locationId: f.locationId }, { $set: { registration: "regular", gstin: "27ABCDE1234F1Z5" } });
    const input = { ...f.input, expectedTotalPaise: 1801, invoiceDiscountPaise: 100, roundOffPaise: 1, lines: [{ ...f.input.lines[0], discountPaise: 100 }] };
    const response = await post(f, input); expect(response.statusCode, response.body).toBe(201);
    const invoice = (await get(f, `invoices/${response.json().data.invoiceId}`)).json().data;
    expect(invoice.calculation.totals).toMatchObject({ lineDiscountPaise: 100, invoiceDiscountPaise: 100, grossAmountPaise: 1800, roundOffPaise: 1, payablePaise: 1801 });
    expect(invoice.items[0].baseAmountPaise + invoice.items[0].cgstPaise + invoice.items[0].sgstPaise).toBe(1800);
    expect(invoice.discount).toBe(2); expect(invoice.totalAmount).toBe(18.01);
  });
  it("captures an actual business customer revision and keeps the issued identity after master edits", async () => {
    const f = await fixture(), party = await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Recorded customer", normalizedName: "recorded customer", address: "Actual address", kinds: ["customer"], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
    const response = await post(f, { ...f.input, customerId: party.id, expectedCustomerRevision: 0 }); expect(response.statusCode, response.body).toBe(201);
    await PharmacyParty.updateOne({ _id: party.id }, { $set: { name: "Changed customer", archived: true } });
    expect((await get(f, `invoices/${response.json().data.invoiceId}`)).json().data).toMatchObject({ customerSnapshot: { anonymous: false, name: "Recorded customer", partyId: party.id }, taxDocument: { recipient: { name: "Recorded customer" } } });
  });
  it("serializes last-unit sales with different keys and rolls back the losing operation", async () => {
    const f = await fixture(), input = { ...f.input, expectedTotalPaise: 10000, lines: [{ ...f.input.lines[0], quantity: 10 }] };
    const responses = await Promise.all([post(f, input), post(f, input)]); expect(responses.map(result => result.statusCode).sort()).toEqual([201, 409]);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(0); expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(1);
  });
  it("rolls back stock and sources when confirmed total differs or required audit fails", async () => {
    const f = await fixture(), requestKey = key(); expect((await post(f, { ...f.input, expectedTotalPaise: 1999 }, requestKey)).statusCode).toBe(409);
    const create = AuditLog.create.bind(AuditLog), spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_COUNTER_INVOICE_ISSUED") throw new Error("Synthetic audit failure"); return (create as any)(docs, ...args); }) as any);
    try { expect((await post(f)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10); expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await PharmacyDispense.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect(await OperationReceipt.exists({ key: requestKey })).toBeNull(); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, kind: "dispense" })).toBe(0);
  });
  it("freezes issued kind, customer, monetary and allocation facts", async () => {
    const f = await fixture(), result = await issued(f);
    for (const patch of [{ kind: "clinical" }, { customerSnapshot: { anonymous: false, name: "Rewritten" } }, { totalAmount: 1 }, { "calculation.totals.payablePaise": 1 }]) await expect(Invoice.updateOne({ _id: result.invoiceId }, { $set: patch })).rejects.toThrow(/rewritten|immutable/);
    await expect(Invoice.deleteOne({ _id: result.invoiceId })).rejects.toThrow(/rewritten|immutable/);
    await expect(PharmacyDispense.updateOne({ _id: result.dispenseId }, { $set: { lines: [] } })).rejects.toThrow(/append-only/);
    const broken = (await Invoice.findById(result.invoiceId))!.toObject(); delete broken._id; broken.invoiceNumber = "I00012627/999999"; broken.totalAmount = 1;
    await expect(Invoice.create(broken)).rejects.toThrow(/reconcile/);
  });
  it.each(["schedule_h", "schedule_h1", "schedule_x", "narcotic", "unreviewed", "stale units", "missing MRP", "stock mismatch"])("rejects %s before any committed issue", async kind => {
    const f = await fixture();
    if (kind.startsWith("schedule") || kind === "narcotic") await Medicine.updateOne({ _id: f.medicine.id }, { $set: { scheduleType: kind } });
    if (kind === "unreviewed") await Medicine.updateOne({ _id: f.medicine.id }, { $unset: { dispensingReview: 1 } });
    if (kind === "stale units") f.input.lines[0].expectedUnitVersion = 2;
    if (kind === "missing MRP") await MedicineBatch.collection.updateOne({ medicineId: f.medicine._id }, { $unset: { mrpPaise: 1, mrp: 1 } });
    if (kind === "stock mismatch") await Medicine.updateOne({ _id: f.medicine.id }, { $set: { stockQuantity: 11 } });
    const response = await post(f); expect(response.statusCode, response.body).toBe(409); expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(kind === "stock mismatch" ? 11 : 10);
  });
  it("requires sale authority, current branch and original actor recovery; consumers cannot read counter invoices", async () => {
    const f = await fixture(), requestKey = key(), result = await post(f, f.input, requestKey); expect(result.statusCode, result.body).toBe(201);
    const other = await fixture(); expect((await get(other, `invoices/${result.json().data.invoiceId}`)).statusCode).toBe(404);
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: ["VIEW_INVOICES", "MANAGE_INVOICES"] } });
    expect((await get(f, `sale-operations/${requestKey}`)).statusCode).toBe(403);
    const patientUser = await User.create({ name: "Consumer", email: `${key()}@example.test`, role: "patient" });
    const auth = await createAuthSession({ id: patientUser.id, role: "patient", email: patientUser.email!, organization_id: f.organizationId });
    expect((await get({ ...f, headers: { authorization: `Bearer ${auth.accessToken}` } }, `invoices/${result.json().data.invoiceId}`)).statusCode).toBe(403);
  });
  it("keeps retail IDs out of clinical lists, detail, collection, payment links and insurance paths", async () => {
    const f = await fixture(["PHARMACY_SELL", "VIEW_INVOICES", "MANAGE_INVOICES", "MANAGE_BILLING", "VIEW_EHR"]), result = await issued(f), id = result.invoiceId;
    const list = await app.inject({ method: "GET", url: `/api/invoices?locationId=${f.locationId}`, headers: f.headers }); expect(list.statusCode, list.body).toBe(200); expect(list.body).not.toContain(id);
    for (const request of [
      { method: "GET" as const, url: `/api/invoices/${id}` },
      { method: "PUT" as const, url: `/api/invoices/${id}/pay`, payload: { paymentMethod: "cash" } },
      { method: "POST" as const, url: `/api/invoices/${id}/payments`, payload: { amount: 1, paymentMethod: "cash" } },
      { method: "POST" as const, url: "/api/billing/payment-link", payload: { invoiceId: id, amount: 1 } },
    ]) { const response = await app.inject({ ...request, headers: { ...f.headers, "idempotency-key": key() } }); expect([403, 404]).toContain(response.statusCode); }
    await expect(Invoice.create({ organizationId: f.organizationId, locationId: f.locationId, invoiceNumber: key(), items: [{ description: "Clinical", amount: 1, quantity: 1 }], subtotal: 1, totalAmount: 1 })).rejects.toThrow(/patientId|doctorId/);
  });
  it("keeps authorized history/recovery after disable and rejects new issue", async () => {
    const f = await fixture(), requestKey = key(), result = await post(f, f.input, requestKey); expect(result.statusCode).toBe(201);
    await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": false } });
    expect((await get(f, `invoices/${result.json().data.invoiceId}`)).statusCode).toBe(200); expect((await get(f, `sale-operations/${requestKey}`)).statusCode).toBe(200); expect((await post(f)).statusCode).toBe(409);
  });
  it("rolls back an earlier product allocation when a later product is unavailable", async () => {
    const f = await fixture(), response = await post(f, { ...f.input, lines: [...f.input.lines, { ...f.input.lines[0], lineId: key(), medicineId: new mongoose.Types.ObjectId().toString() }] });
    expect(response.statusCode).toBe(409); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await PharmacyDispense.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect(await StockMovement.countDocuments({ medicineId: f.medicine.id, kind: "dispense" })).toBe(0);
  });
  it("requires current issuer, customer and tenant evidence before issue", async () => {
    const f = await fixture();
    expect((await post(f, { ...f.input, expectedProfileRevision: 2 })).statusCode).toBe(409);
    const other = await fixture(), party = await PharmacyParty.create({ organizationId: other.organizationId, locationIds: [other.locationId], name: "Other customer", normalizedName: "other customer", address: "Actual address", kinds: ["customer"], gstRegistration: "unregistered", createdBy: other.user.id, updatedBy: other.user.id });
    expect((await post(f, { ...f.input, customerId: party.id, expectedCustomerRevision: 0 })).statusCode).toBe(409);
    expect((await post(f, { ...f.input, organizationId: other.organizationId })).statusCode).toBe(403);
    await PharmacyTaxProfile.updateOne({ locationId: f.locationId }, { $set: { electronicReportingRequired: true } });
    expect((await post(f)).statusCode).toBe(409); expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  });
  it("does not let another staff actor recover a sale reference", async () => {
    const f = await fixture(), requestKey = key(); expect((await post(f, f.input, requestKey)).statusCode).toBe(201);
    const user = await User.create({ name: "Other seller", email: `${key()}@example.test`, role: f.role });
    await OrgMember.create({ organizationId: f.organizationId, userId: user.id, role: f.role, locationAccess: { mode: "selected", locationIds: [f.locationId] } });
    const auth = await createAuthSession({ id: user.id, role: f.role, email: user.email!, organization_id: f.organizationId });
    expect((await get({ ...f, headers: { authorization: `Bearer ${auth.accessToken}` } }, `sale-operations/${requestKey}`)).statusCode).toBe(404);
  });
  it("rejects clinical IDs, client prices, numeric strings, null and unsafe quantities", async () => {
    const f = await fixture();
    for (const body of [{ ...f.input, patientId: new mongoose.Types.ObjectId().toString() }, { ...f.input, totalAmount: 1 }, { ...f.input, expectedTotalPaise: null },
      ...[0, -1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1].map(quantity => ({ ...f.input, lines: [{ ...f.input.lines[0], quantity }] }))]) expect((await post(f, body)).statusCode).toBe(400);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10);
  });
});

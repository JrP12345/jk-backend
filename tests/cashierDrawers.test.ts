import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { Medicine } from "../models/Medicine.ts";
import { Patient } from "../models/Patient.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
async function fixture() {
  const f = await pharmacyRetailFixture(["PHARMACY_SELL", "PHARMACY_CLOSE_TILL"]);
  await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: ["PHARMACY_SELL", "PHARMACY_CLOSE_TILL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_APPROVE_REFUND"] } });
  return f;
}
type F = Awaited<ReturnType<typeof fixture>>;
const post = (f: F, path: string, body: object, ref = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": ref }, payload: { locationId: f.locationId, ...body } });
const get = (f: F, path = "till") => app.inject({ method: "GET", url: `/api/pharmacy/${path}?locationId=${f.locationId}`, headers: f.headers });
async function open(f: F, float = 1000, code = "COUNTER-1") { const res = await post(f, "till/open", { drawerCode: code, openingFloatPaise: float }); expect(res.statusCode, res.body).toBe(201); return res.json().data.drawer; }
async function sale(f: F) { const medicine = await Medicine.findById(f.medicine.id); const res = await post(f, "sales", { ...f.input, lines: f.input.lines.map(row => ({ ...row, expectedStockRevision: medicine!.stockRevision })) }); expect(res.statusCode, res.body).toBe(201); return res.json().data.invoiceId; }
const collect = (f: F, id: string, ref = key()) => post(f, `invoices/${id}/collections`, { expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 1000, entries: [{ componentId: "cash-component", amountPaise: 1000, paymentMethod: "cash" }, { componentId: "upi-component", amountPaise: 1000, paymentMethod: "upi", referenceNumber: "ACTUAL-UPI" }] }, ref);
const move = (f: F, id: string, revision: number, direction: "in" | "out", amountPaise: number, ref = key()) => post(f, `till/${id}/movements`, { expectedRevision: revision, direction, amountPaise, referenceNumber: `ACTUAL-${ref}`, reviewReference: "Synthetic actual reviewed cash movement" }, ref);
const close = (f: F, id: string, revision: number, countedCashPaise: number, extra: object = {}, ref = key()) => post(f, `till/${id}/close`, { expectedRevision: revision, countedCashPaise, ...extra }, ref);

describe("Owned physical drawer lifecycle", () => {
  it("opens actual identity, captures currency/timezone, and replays the original opening after close", async () => {
    const f = await fixture(), ref = key(), body = { drawerCode: "counter-1", openingFloatPaise: 2500 };
    const first = await post(f, "till/open", body, ref); expect(first.statusCode, first.body).toBe(201); const drawer = first.json().data.drawer;
    expect(drawer).toMatchObject({ status: "active", cashierId: f.user.id, cashierName: f.user.name, organizationId: f.organizationId, locationId: f.locationId, drawerCode: "COUNTER-1", currency: "INR", timezone: "Asia/Kolkata", revision: 0, drawerTotals: { expectedCashPaise: 2500 } });
    expect((await close(f, drawer.id, 0, 2500)).statusCode).toBe(201);
    expect((await post(f, "till/open", body, ref)).json().data).toEqual({ ...first.json().data, replayed: true });
    expect((await get(f, `till-operations/${ref}`)).json().data.drawer.status).toBe("active");
    expect((await get(f)).json().data.active).toBeNull();
  });
  it("requires explicit keys, exact bounded money and command-specific fields", async () => {
    const f = await fixture();
    expect((await app.inject({ method: "POST", url: "/api/pharmacy/till/open", headers: f.headers, payload: { locationId: f.locationId, drawerCode: "ONE", openingFloatPaise: 0 } })).statusCode).toBe(428);
    for (const body of [{ drawerCode: "invalid code", openingFloatPaise: 0 }, { drawerCode: "ONE", openingFloatPaise: 0.1 }, { drawerCode: "ONE", openingFloatPaise: -1 }, { drawerCode: "ONE", openingFloatPaise: 0, countedCashPaise: 10 }]) expect((await post(f, "till/open", body)).statusCode).toBe(400);
    expect(await CashierShift.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("serializes concurrent opens and blocks a second drawer for the same cashier", async () => {
    const f = await fixture(), ref = key(), body = { drawerCode: "ONE", openingFloatPaise: 0 };
    const same = await Promise.all([post(f, "till/open", body, ref), post(f, "till/open", body, ref)]);
    expect(same.map(res => res.statusCode)).toEqual([201, 201]); expect(same[0].json().data.resultId).toBe(same[1].json().data.resultId);
    expect((await post(f, "till/open", { drawerCode: "TWO", openingFloatPaise: 0 })).statusCode).toBe(409);
    expect((await post(f, "till/open", { ...body, openingFloatPaise: 1 }, ref)).statusCode).toBe(409);
    expect(await CashierShift.countDocuments({ organizationId: f.organizationId, status: "active" })).toBe(1);
  });
  it("assigns split components and closes float plus cash receipts and movements with exact evidence", async () => {
    const f = await fixture(), drawer = await open(f), invoiceId = await sale(f), payment = await collect(f, invoiceId);
    expect(payment.statusCode, payment.body).toBe(201); expect(payment.json().data).toMatchObject({ shiftId: drawer.id, drawerCode: "COUNTER-1" });
    const invoice = await Invoice.findById(invoiceId); expect(invoice.payments.every((row: any) => String(row.shiftId) === drawer.id)).toBe(true);
    expect((await move(f, drawer.id, 1, "out", 500)).statusCode).toBe(201);
    expect((await move(f, drawer.id, 2, "in", 200)).statusCode).toBe(201);
    const ref = key(), res = await close(f, drawer.id, 3, 1700, { handoverNotes: "Counted and handed over" }, ref); expect(res.statusCode, res.body).toBe(201);
    expect(res.json().data.drawer).toMatchObject({ status: "closed", closedBy: f.user.id, cashVariance: 0, drawerTotals: { expectedCashPaise: 1700, incoming: { cash: 1000, upi: 1000 }, outgoing: { cash: 500 }, eventIncoming: { cash: 200 }, receiptCount: 2, eventCount: 2, invoiceCount: 1 } });
    expect(res.json().data.drawer.receiptEvidence).toHaveLength(2); expect(res.json().data.drawer.eventEvidence).toHaveLength(2); expect(res.json().data.drawer.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await close(f, drawer.id, 3, 1700, { handoverNotes: "Counted and handed over" }, ref)).json().data).toEqual({ ...res.json().data, replayed: true });
  });
  it("requires a drawer before collection and prevents posting after close while preserving original recovery", async () => {
    const f = await fixture(), invoiceId = await sale(f), paymentKey = key();
    expect((await collect(f, invoiceId, paymentKey)).statusCode).toBe(428);
    expect(await InvoiceCollectionReceipt.countDocuments({ invoiceId })).toBe(0);
    const drawer = await open(f), payment = await collect(f, invoiceId, paymentKey); expect(payment.statusCode, payment.body).toBe(201);
    expect((await close(f, drawer.id, 1, 2000)).statusCode).toBe(201);
    expect((await collect(f, invoiceId, paymentKey)).json().data.receiptId).toBe(payment.json().data.receiptId);
    const nextInvoice = await sale(f); expect((await collect(f, nextInvoice)).statusCode).toBe(428);
    expect((await move(f, drawer.id, 2, "in", 100)).statusCode).toBe(409);
  });
  it("blocks negative recorded cash, rolls back the event/revision, and accepts a corrected same reference", async () => {
    const f = await fixture(), drawer = await open(f, 100), ref = key();
    expect((await move(f, drawer.id, 0, "out", 101, ref)).statusCode).toBe(409);
    expect(await PharmacyCashEvent.countDocuments({ shiftId: drawer.id })).toBe(0); expect((await CashierShift.findById(drawer.id))!.revision).toBe(0);
    expect((await move(f, drawer.id, 0, "out", 100, ref)).statusCode).toBe(201);
    expect((await close(f, drawer.id, 1, 0)).statusCode).toBe(201);
  });
  it("requires explained variance and rejects stale revisions before closing", async () => {
    const f = await fixture(), drawer = await open(f);
    expect((await close(f, drawer.id, 1, 1000)).statusCode).toBe(409);
    expect((await close(f, drawer.id, 0, 900)).statusCode).toBe(400);
    const res = await close(f, drawer.id, 0, 900, { varianceReason: "Counted shortage reviewed by supervisor" }); expect(res.statusCode, res.body).toBe(201); expect(res.json().data.drawer.cashVariance).toBe(-1);
  });
  it("rolls back drawer creation and movements if the required audit fails", async () => {
    const f = await fixture(), ref = key();
    const spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable"));
    try { expect((await post(f, "till/open", { drawerCode: "ONE", openingFloatPaise: 0 }, ref)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect(await CashierShift.countDocuments({ organizationId: f.organizationId })).toBe(0);
    const drawer = await open(f, 100), movementKey = key();
    const fail = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable"));
    try { expect((await move(f, drawer.id, 0, "in", 100, movementKey)).statusCode).toBe(500); } finally { fail.mockRestore(); }
    expect(await PharmacyCashEvent.countDocuments({ shiftId: drawer.id })).toBe(0); expect((await CashierShift.findById(drawer.id))!.revision).toBe(0);
    expect((await move(f, drawer.id, 0, "in", 100, movementKey)).statusCode).toBe(201);
  });
  it("isolates tenants, operator recovery and current revoked authority", async () => {
    const f = await fixture(), other = await fixture(), drawer = await open(f);
    expect((await get(other, `till/${drawer.id}`)).statusCode).toBe(404);
    expect((await close(other, drawer.id, 0, 1000)).statusCode).toBe(404);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_SELL"] } });
    expect((await get(f)).statusCode).toBe(403); expect((await close(f, drawer.id, 0, 1000)).statusCode).toBe(403);
  });
  it("keeps refunds/closing continuity available after new pharmacy activity is disabled", async () => {
    const f = await fixture(); await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": false } });
    const drawer = await open(f); expect((await move(f, drawer.id, 0, "out", 100)).statusCode).toBe(201);
    expect((await close(f, drawer.id, 1, 900)).statusCode).toBe(201);
  });
  it("does not lose a receipt racing against close or post to a closed drawer", async () => {
    const f = await fixture(), drawer = await open(f), invoiceId = await sale(f);
    const results = await Promise.all([collect(f, invoiceId), close(f, drawer.id, 0, 1000)]);
    expect(results.filter(res => res.statusCode === 201)).toHaveLength(1);
    const saved = await CashierShift.findById(drawer.id), invoice = await Invoice.findById(invoiceId);
    if (saved!.status === "closed") expect(invoice.amountPaid).toBe(0);
    else { expect(invoice.amountPaid).toBe(20); expect(saved!.revision).toBe(1); expect((await close(f, drawer.id, 1, 2000)).statusCode).toBe(201); }
  });
  it("keeps opening facts and closed evidence immutable", async () => {
    const f = await fixture(), drawer = await open(f);
    const current = (await CashierShift.findById(drawer.id))!; current.openingFloatPaise = 999;
    await expect(current.save()).rejects.toThrow(/immutable/);
    expect((await close(f, drawer.id, 0, 1000)).statusCode).toBe(201);
    const saved = (await CashierShift.findById(drawer.id))!; saved.handoverNotes = "Rewrite"; await expect(saved.save()).rejects.toThrow(/immutable/);
    await expect(CashierShift.updateOne({ _id: drawer.id }, { $set: { status: "active" } })).rejects.toThrow(/immutable/);
    await expect(CashierShift.deleteOne({ _id: drawer.id })).rejects.toThrow(/immutable/);
  });
  it("retains actual currency and rejects INR collections into a foreign currency drawer", async () => {
    const f = await fixture(), invoiceId = await sale(f); await Organization.updateOne({ _id: f.organizationId }, { $set: { currency: "USD" } });
    const drawer = await open(f); expect(drawer.currency).toBe("USD"); expect((await collect(f, invoiceId)).statusCode).toBe(409);
  });
  it("keeps two cashiers separate, prevents sharing the same physical drawer, and records manager handover", async () => {
    const f = await fixture(), drawer = await open(f);
    const user = await User.create({ name: "Actual second cashier", email: `${key()}@example.test`, role: f.role });
    await OrgMember.create({ organizationId: f.organizationId, userId: user.id, role: f.role, locationAccess: { mode: "selected", locationIds: [f.locationId] } });
    const session = await createAuthSession({ id: user.id, role: f.role, email: user.email!, organization_id: f.organizationId });
    const other = { ...f, user, headers: { authorization: `Bearer ${session.accessToken}` } };
    expect((await post(other, "till/open", { drawerCode: "COUNTER-1", openingFloatPaise: 0 })).statusCode).toBe(409);
    const second = await open(other, 2000, "COUNTER-2"); expect((await get(f)).json().data.active.id).toBe(drawer.id); expect((await get(other)).json().data.active.id).toBe(second.id);
    expect((await close(other, drawer.id, 0, 1000)).statusCode).toBe(404);
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $addToSet: { permissions: "MANAGE_ORGANIZATION" } });
    const closed = await close(other, drawer.id, 0, 1000); expect(closed.statusCode, closed.body).toBe(201);
    expect(closed.json().data.drawer).toMatchObject({ cashierId: f.user.id, cashierName: f.user.name, closedBy: user.id, closedByName: user.name });
    expect((await get(other)).json().data.active.id).toBe(second.id);
  });
  it("opens a clinical drawer without pharmacy permission and tags full and partial clinical receipts", async () => {
    const f = await fixture(); await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["MANAGE_BILLING"] } });
    const opened = await app.inject({ method: "POST", url: "/api/billing/till/drawers/open", headers: { ...f.headers, "idempotency-key": key() }, payload: { locationId: f.locationId, drawerCode: "CLINICAL-1", openingFloatPaise: 1000 } }); expect(opened.statusCode, opened.body).toBe(201);
    expect((await get(f)).statusCode).toBe(403); const drawer = opened.json().data.drawer;
    const patient = await Patient.create({ organizationId: f.organizationId, name: "Synthetic clinical patient" });
    const invoice = await Invoice.create({ organizationId: f.organizationId, locationId: f.locationId, doctorId: f.user.id, patientId: patient._id, invoiceNumber: `CLINICAL-${key()}`, items: [{ description: "Actual service", amount: 1, quantity: 1 }], subtotal: 1, totalAmount: 1, amountPaid: 0, balanceDue: 1, currency: "INR", status: "unpaid" });
    const partial = await app.inject({ method: "POST", url: `/api/invoices/${invoice.id}/payments`, headers: { ...f.headers, "idempotency-key": key() }, payload: { amount: 0.23, paymentMethod: "cash" } }); expect(partial.statusCode, partial.body).toBe(200);
    const paid = await app.inject({ method: "PUT", url: `/api/invoices/${invoice.id}/pay`, headers: { ...f.headers, "idempotency-key": key() }, payload: { paymentMethod: "cash" } }); expect(paid.statusCode, paid.body).toBe(200);
    const saved = await Invoice.findById(invoice._id); expect(saved.payments).toHaveLength(2); expect(saved.payments.every((row: any) => String(row.shiftId) === drawer.id && String(row.actorId) === f.user.id)).toBe(true);
    const closed = await app.inject({ method: "POST", url: `/api/billing/till/drawers/${drawer.id}/close`, headers: { ...f.headers, "idempotency-key": key() }, payload: { locationId: f.locationId, expectedRevision: 2, countedCashPaise: 1100 } }); expect(closed.statusCode, closed.body).toBe(201); expect(closed.json().data.drawer.drawerTotals).toMatchObject({ incoming: { cash: 100 }, expectedCashPaise: 1100, receiptCount: 2 });
  });
  it("concurrent close requests commit one immutable close and reject a changed new key", async () => {
    const f = await fixture(), drawer = await open(f), reference = key();
    const same = await Promise.all([close(f, drawer.id, 0, 1000, {}, reference), close(f, drawer.id, 0, 1000, {}, reference)]); expect(same.map(res => res.statusCode)).toEqual([201, 201]);
    expect(same[0].json().data.drawer.evidenceHash).toBe(same[1].json().data.drawer.evidenceHash);
    expect((await close(f, drawer.id, 0, 1000)).statusCode).toBe(409); expect(await AuditLog.countDocuments({ targetId: drawer.id, action: "CASHIER_DRAWER_CLOSE" })).toBe(1);
  });
  it("keeps a drawer interval across local midnight and counts only explicitly assigned current receipts", async () => {
    const f = await fixture(), startedAt = new Date(Date.now() - 86400000);
    const drawer = await CashierShift.create({ kind: "drawer", organizationId: f.organizationId, locationId: f.locationId, cashierId: f.user.id, cashierName: f.user.name, organizationName: "Synthetic retail", locationName: "Retail branch", drawerCode: "MIDNIGHT", openingFloatPaise: 1000, collectionBasis: "drawer_v1", currency: "INR", timezone: "Asia/Kolkata", startedAt, shiftDate: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(startedAt), status: "active" });
    const invoiceId = await sale(f); expect((await collect(f, invoiceId)).statusCode).toBe(201);
    const result = await close(f, drawer.id, 1, 2000); expect(result.statusCode, result.body).toBe(201); expect(result.json().data.drawer.drawerTotals).toMatchObject({ expectedCashPaise: 2000, incoming: { cash: 1000, upi: 1000 }, receiptCount: 2 });
    expect(Date.parse(result.json().data.drawer.endedAt) - Date.parse(result.json().data.drawer.startedAt)).toBeGreaterThanOrEqual(86400000);
  });
  it("refuses a corrupted saved close instead of presenting mismatched evidence", async () => {
    const f = await fixture(), drawer = await open(f); expect((await close(f, drawer.id, 0, 1000)).statusCode).toBe(201);
    // Synthetic storage corruption probe; no application mutation route can rewrite this evidence.
    await CashierShift.collection.updateOne({ _id: new mongoose.Types.ObjectId(drawer.id) }, { $set: { "drawerTotals.incoming.cash": 1 } });
    expect((await get(f, `till/${drawer.id}`)).statusCode).toBe(409); expect((await get(f, "till/history")).statusCode).toBe(409);
  });
});

import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Patient } from "../models/Patient.ts";
import { Role } from "../models/Role.ts";
import { Invoice } from "../models/Invoice.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { collectTillReceipts } from "../services/TillCollectionService.ts";
import { locationDateKey, locationDayRange } from "../utilities/locationTime.ts";

describe("Till collections use committed receipts and the location business day", () => {
  let orgId: string, doctorId: string, headers: { authorization: string };
  async function principal(organizationId: string, role = "admin", locationIds?: string[]) {
    const user = await User.create({ name: `Till ${role}`, role, email: `${crypto.randomUUID()}@example.test` });
    await OrgMember.create({ organizationId, userId: user.id, role, locationAccess: locationIds ? { mode: "selected", locationIds } : { mode: "all" } });
    return { user, headers: { authorization: `Bearer ${(await createAuthSession({ id: user.id, role, email: user.email!, organization_id: organizationId })).accessToken}` } };
  }
  beforeAll(async () => {
    orgId = (await Organization.create({ name: "Till receipt tests", city: "Pune", countryCode: "IN", currency: "INR", timezone: "Asia/Kolkata" })).id;
    headers = (await principal(orgId)).headers;
    doctorId = (await User.create({ name: "Till doctor", role: "doctor", email: `${crypto.randomUUID()}@example.test` })).id;
  });
  async function fixture(timezone?: string, organizationId = orgId) {
    const location = await Location.create({ organizationId, name: "Till branch", city: "Pune", timezone });
    const patient = await Patient.create({ organizationId, name: "Till patient" });
    return { location, patient, organizationId };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const receipt = (amount: number, paymentMethod: string, paidAt = "2026-10-18T08:00:00Z", extra = {}) => ({ amount, paymentMethod, paidAt: new Date(paidAt), ...extra });
  async function bill(f: Fixture, payments: any[] = [], extra: Record<string, unknown> = {}) {
    const paid = payments.reduce((sum, entry) => sum + entry.amount, 0);
    return Invoice.create({ organizationId: f.organizationId, locationId: f.location.id, patientId: f.patient.id, doctorId,
      invoiceNumber: `TILL-${crypto.randomUUID()}`, items: [{ description: "Test charge", amount: 100, quantity: 1 }], subtotal: 100, totalAmount: 100,
      currency: "INR", status: paid >= 100 ? "paid" : paid > 0 ? "partially_paid" : "unpaid", amountPaid: paid, payments, ...extra });
  }
  const summary = (f: Fixture, date = "2026-10-18", auth = headers) => app.inject({ method: "GET", url: `/api/billing/till/summary?locationId=${f.location.id}&date=${encodeURIComponent(date)}`, headers: auth });
  const close = (f: Fixture, actualCashCounted: unknown, extra = {}, auth = headers) => app.inject({ method: "POST", url: "/api/billing/till/close", headers: { ...auth, "idempotency-key": crypto.randomUUID() }, payload: { locationId: f.location.id, actualCashCounted, ...extra } });
  it("deduplicates daily receipt reports without including physical drawer sessions", async () => {
    const f = await fixture(), reference = crypto.randomUUID(), body = { locationId: f.location.id, actualCashCounted: 0 }, save = (payload = body) => app.inject({ method: "POST", url: "/api/billing/till/close", headers: { ...headers, "idempotency-key": reference }, payload });
    const first = await save(); expect(first.statusCode, first.body).toBe(201); const replay = await save(); expect(replay.statusCode).toBe(201); expect(replay.json().data.id).toBe(first.json().data.id); expect(await CashierShift.countDocuments({ locationId: f.location.id, kind: "receipt_report" })).toBe(1);
    expect((await save({ ...body, actualCashCounted: 1 } as typeof body)).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/billing/till/close", headers, payload: body })).statusCode).toBe(428);
    expect((await summary(f, first.json().data.shiftDate)).json().data.latestShift.kind).toBe("receipt_report");
  });
  it("counts a cash installment and later UPI receipt on their actual days, ignoring later invoice edits", async () => {
    const f = await fixture();
    const invoice = await bill(f, [receipt(40, "cash"), receipt(60, "upi", "2026-10-19T08:00:00Z")], { paymentMethod: "upi", paymentDate: new Date("2026-10-19T08:00:00Z") });
    const first = await summary(f); expect(first.statusCode, first.body).toBe(200);
    expect(first.json().data.systemTotals).toMatchObject({ cash: 40, upi: 0, total: 40, receiptCount: 1, invoiceCount: 1, legacyReceiptCount: 0 });
    await Invoice.updateOne({ _id: invoice._id }, { $set: { notes: "Unrelated later edit", paymentMethod: "card" } });
    expect((await summary(f)).json().data.systemTotals.total).toBe(40);
    expect((await summary(f, "2026-10-19")).json().data.systemTotals).toMatchObject({ cash: 0, upi: 60, total: 60, receiptCount: 1 });
    expect((await summary(f, "2026-10-20")).json().data.systemTotals.total).toBe(0);
  });
  it("includes a partially paid invoice and separates online/card/UPI methods using exact paise", async () => {
    const f = await fixture(); await bill(f, [receipt(0.1, "cash"), receipt(0.2, "cash"), receipt(10, "online"), receipt(20, "card"), receipt(15, "upi")]);
    const result = (await summary(f)).json().data;
    expect(result.systemTotals).toMatchObject({ cash: 0.3, other: 10, card: 20, upi: 15, total: 45.3, invoiceCount: 1, receiptCount: 5 });
    expect(result.reconciliation.requiresReview).toBe(false);
  });
  it("excludes a later committed receipt from an earlier cutoff without declaring it future-dated", async () => {
    const f = await fixture(); await bill(f, [receipt(40, "cash"), receipt(60, "upi", "2026-10-18T08:00:01Z")]);
    const first = await collectTillReceipts(orgId, f.location.id, "2026-10-18", new Date("2026-10-18T08:00:00Z"));
    expect(first.systemTotals.total).toBe(40); expect(first.reconciliation.requiresReview).toBe(false);
    expect((await collectTillReceipts(orgId, f.location.id, "2026-10-18", new Date("2026-10-18T08:00:01Z"))).systemTotals.total).toBe(100);
  });
  it("consumes actual installment API receipts without counting aggregate balances twice", async () => {
    const f = await fixture(), invoice = await bill(f);
    const pay = (amount: number, paymentMethod: string) => app.inject({ method: "POST", url: `/api/invoices/${invoice.id}/payments`,
      headers: { ...headers, "idempotency-key": crypto.randomUUID() }, payload: { amount, paymentMethod } });
    const first = await pay(40, "cash"); expect(first.statusCode, first.body).toBe(200);
    const today = locationDateKey(new Date(), "Asia/Kolkata");
    expect((await summary(f, today)).json().data.systemTotals.total).toBe(40);
    const second = await pay(60, "upi"); expect(second.statusCode, second.body).toBe(200);
    expect((await summary(f, today)).json().data.systemTotals).toMatchObject({ cash: 40, upi: 60, total: 100, receiptCount: 2 });
  });
  it("uses the exact India midnight boundaries and inherits organization timezone", async () => {
    const f = await fixture();
    await bill(f, [receipt(1, "cash", "2026-10-17T18:29:59.999Z"), receipt(2, "cash", "2026-10-17T18:30:00Z"), receipt(3, "cash", "2026-10-18T18:29:59.999Z"), receipt(4, "cash", "2026-10-18T18:30:00Z")]);
    const result = (await summary(f)).json().data;
    expect(result.timezone).toBe("Asia/Kolkata"); expect(result.periodStart).toBe("2026-10-17T18:30:00.000Z");
    expect(result.systemTotals.total).toBe(5); expect(result.systemTotals.receiptCount).toBe(2);
  });
  it.each(["2026-03-08", "2026-11-01"])("respects the branch's DST business day %s", async date => {
    const f = await fixture("America/New_York"), range = locationDayRange(date, "America/New_York");
    await bill(f, [receipt(1, "cash", new Date(range.start.getTime() - 1).toISOString()), receipt(2, "cash", range.start.toISOString()), receipt(3, "cash", range.end.toISOString()), receipt(4, "cash", new Date(range.end.getTime() + 1).toISOString())]);
    const result = await collectTillReceipts(orgId, f.location.id, date, new Date("2027-01-01"));
    expect(result.systemTotals.total).toBe(5);
    expect(range.end.getTime() - range.start.getTime() + 1).toBe((date.includes("03-08") ? 23 : 25) * 3600000);
  });
  it("counts labelled legacy full-payment evidence once and never falls back when receipt rows exist", async () => {
    const f = await fixture(); await bill(f, [], { status: "paid", amountPaid: 100, paymentMethod: "cash", paymentDate: new Date("2026-10-18T08:00:00Z") });
    await bill(f, [receipt(40, "upi", "2026-10-17T08:00:00Z")], { paymentDate: new Date("2026-10-18T08:00:00Z"), paymentMethod: "cash" });
    const result = (await summary(f)).json().data;
    expect(result.systemTotals).toMatchObject({ cash: 100, total: 100, invoiceCount: 1, receiptCount: 1, legacyReceiptCount: 1 });
    expect(result.reconciliation.requiresReview).toBe(false);
  });
  it.each(["missing date", "missing amount", "partial legacy", "unexplained residual"])("flags %s without inventing a collection", async kind => {
    const f = await fixture();
    const invoice = await bill(f, kind === "unexplained residual" ? [receipt(60, "upi")] : [], { status: "paid", amountPaid: kind === "partial legacy" ? 40 : 100, paymentMethod: "cash", paymentDate: new Date("2026-10-18T08:00:00Z") });
    if (kind === "missing date") await Invoice.collection.updateOne({ _id: invoice._id }, { $unset: { paymentDate: 1 } });
    if (kind === "missing amount") await Invoice.collection.updateOne({ _id: invoice._id }, { $unset: { amountPaid: 1 } });
    const result = (await summary(f)).json().data;
    expect(result.systemTotals.total).toBe(kind === "unexplained residual" ? 60 : 0); expect(result.reconciliation.requiresReview).toBe(true);
  });
  it.each(["missing receipt date", "negative receipt", "duplicate key", "unknown method", "future receipt"])("flags %s and excludes uncertain receipt amounts", async kind => {
    const f = await fixture(), invoice = await bill(f, [receipt(40, "cash")]);
    if (kind === "missing receipt date") await Invoice.collection.updateOne({ _id: invoice._id }, { $unset: { "payments.0.paidAt": 1 } });
    if (kind === "negative receipt") await Invoice.collection.updateOne({ _id: invoice._id }, { $set: { "payments.0.amount": -40 } });
    if (kind === "duplicate key") await Invoice.collection.updateOne({ _id: invoice._id }, { $set: { payments: [receipt(40, "cash", undefined, { operationKey: "same-key" }), receipt(40, "cash", undefined, { operationKey: "same-key" })], amountPaid: 80 } });
    if (kind === "unknown method") await Invoice.collection.updateOne({ _id: invoice._id }, { $set: { "payments.0.paymentMethod": "cashback" } });
    const date = kind === "future receipt" ? locationDateKey(new Date(Date.now() + 86400000), "Asia/Kolkata") : "2026-10-18";
    if (kind === "future receipt") await Invoice.collection.updateOne({ _id: invoice._id }, { $set: { "payments.0.paidAt": new Date(Date.now() + 86400000) } });
    const result = (await summary(f, date)).json().data;
    expect(result.systemTotals.total).toBe(kind === "duplicate key" ? 40 : 0); expect(result.reconciliation.requiresReview).toBe(true);
  });
  it("retains gross receipts on refunded/cancelled/deleted bills while requiring reversal reconciliation", async () => {
    const f = await fixture();
    await bill(f, [receipt(40, "cash")], { status: "refunded" }); await bill(f, [receipt(30, "upi")], { status: "cancelled" }); await bill(f, [receipt(20, "card")], { deletedAt: new Date() });
    const result = (await summary(f)).json().data;
    expect(result.systemTotals.total).toBe(90); expect(result.reconciliation.issueCount).toBe(3);
  });
  it("never adds unlike currencies to one drawer total", async () => {
    const f = await fixture(); await bill(f, [receipt(40, "cash")], { currency: "USD" });
    const result = (await summary(f)).json().data; expect(result.currency).toBe("INR"); expect(result.systemTotals.total).toBe(0); expect(result.reconciliation.requiresReview).toBe(true);
  });
  it("reports the configured USD currency without relabelling online receipts as UPI", async () => {
    const org = await Organization.create({ name: "US till tests", city: "New York", countryCode: "US", currency: "USD", timezone: "America/New_York" });
    const staff = await principal(org.id), f = await fixture(undefined, org.id);
    await bill(f, [receipt(20, "online")], { currency: "USD" });
    const result = (await summary(f, "2026-10-18", staff.headers)).json().data;
    expect(result.currency).toBe("USD"); expect(result.systemTotals).toMatchObject({ other: 20, upi: 0, total: 20 }); expect(result.reconciliation.requiresReview).toBe(false);
  });
  it("does not count zero-fee courtesy waivers as receipts", async () => {
    const f = await fixture(); await bill(f, [], { totalAmount: 0, status: "paid", paymentMethod: "courtesy_waiver", paymentDate: new Date("2026-10-18") });
    expect((await summary(f)).json().data.systemTotals).toMatchObject({ total: 0, receiptCount: 0, invoiceCount: 0 });
  });
  it("flags unowned branch payment evidence without adopting it or exposing invoice identifiers", async () => {
    const f = await fixture(), invoice = await bill(f, [receipt(40, "cash", new Date().toISOString())]);
    await Invoice.collection.updateOne({ _id: invoice._id }, { $unset: { organizationId: 1 } });
    const result = (await summary(f, locationDateKey(new Date(), "Asia/Kolkata"))).json().data;
    expect(result.systemTotals.total).toBe(0); expect(result.reconciliation.requiresReview).toBe(true);
    expect(JSON.stringify(result.reconciliation)).not.toContain(invoice.id); expect(JSON.stringify(result.reconciliation)).not.toContain(invoice.invoiceNumber);
    expect((await close(f, 40)).statusCode).toBe(409);
  });
  it.each(["2026-02-30", "garbage", "2026-2-01"])("rejects invalid report date %s", async date => {
    const f = await fixture(); expect((await summary(f, date)).statusCode).toBe(400);
  });
  it("saves server-computed receipt totals and required audit together, ignoring submitted totals", async () => {
    const f = await fixture(); await bill(f, [receipt(40, "cash", new Date().toISOString())]);
    const result = await close(f, 40, { systemTotals: { cash: 9000 }, date: "2000-01-01" }); expect(result.statusCode, result.body).toBe(201);
    const data = result.json().data; expect(data).toMatchObject({ collectionBasis: "receipt_v1", timezone: "Asia/Kolkata", currency: "INR", cashVariance: 0, systemTotals: { cash: 40, receiptCount: 1 } });
    expect(data.shiftDate).toBe(locationDateKey(new Date(), "Asia/Kolkata")); expect(await AuditLog.countDocuments({ targetId: data.id, action: "CASHIER_TILL_CLOSE" })).toBe(1);
    const query = await summary(f, data.shiftDate); expect(query.headers["cache-control"]).toBe("no-store"); expect(query.json().data.latestShift._id).toBe(data.id);
  });
  it("blocks close for undated legacy evidence and requires an actual reason for a cash difference", async () => {
    const f = await fixture(); await bill(f, [], { status: "paid", amountPaid: 100, paymentMethod: "cash" });
    expect((await close(f, 100)).statusCode).toBe(409); expect(await CashierShift.countDocuments({ locationId: f.location.id })).toBe(0);
    const clean = await fixture(); expect((await close(clean, 1)).statusCode).toBe(400);
    expect((await close(clean, 1, { varianceReason: "Verified difference" })).statusCode).toBe(201);
  });
  it("rolls back a new report if its required audit fails", async () => {
    const f = await fixture(); const spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic till audit failure"));
    try { expect((await close(f, 0)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect(await CashierShift.countDocuments({ locationId: f.location.id })).toBe(0);
  });
  it.each([-1, "12", 1.001, 1e20])("rejects invalid counted cash %j", async amount => {
    const f = await fixture(); expect((await close(f, amount)).statusCode).toBe(400);
  });
  it("preserves historical snapshots and labels their original calculation basis", async () => {
    const f = await fixture(); const old = await CashierShift.create({ organizationId: orgId, locationId: f.location.id, cashierId: doctorId, cashierName: "Historical cashier", shiftDate: "2026-10-18", systemTotals: { cash: 999, total: 999, invoiceCount: 3 }, actualCashCounted: 999, cashVariance: 0 });
    const result = await app.inject({ method: "GET", url: `/api/billing/till/history?locationId=${f.location.id}`, headers });
    expect(result.json().data[0]).toMatchObject({ collectionBasis: "legacy_invoice_totals", systemTotals: { cash: 999, total: 999 } });
    expect((await CashierShift.collection.findOne({ _id: old._id }))!.collectionBasis).toBeUndefined();
  });
  it("denies consumers and ungranted/foreign branches, even with billing permission", async () => {
    const f = await fixture(), second = await fixture(); const staff = await principal(orgId, "cashier", [f.location.id]);
    expect((await summary(second, undefined, staff.headers)).statusCode).toBe(404); expect((await close(second, 0, {}, staff.headers)).statusCode).toBe(404);
    await Role.create({ organizationId: orgId, name: "patient", permissions: ["MANAGE_BILLING"] }); const patient = await principal(orgId, "patient");
    expect((await summary(f, undefined, patient.headers)).statusCode).toBe(403);
    const foreignOrg = await Organization.create({ name: "Foreign till", city: "Pune" }), foreign = await fixture(undefined, foreignOrg.id);
    expect((await summary(foreign)).statusCode).toBe(404);
    await bill(f, [receipt(50, "cash")], { organizationId: foreignOrg.id }); expect((await summary(f)).json().data.systemTotals.total).toBe(0);
  });
});

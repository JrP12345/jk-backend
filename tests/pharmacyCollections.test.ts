import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { Invoice } from "../models/Invoice.ts";
import { InvoiceCollectionReceipt } from "../models/InvoiceCollectionReceipt.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { Medicine } from "../models/Medicine.ts";
import { Role } from "../models/Role.ts";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { collectTillReceipts } from "../services/TillCollectionService.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
async function fixture(identified = true, permissions = ["PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT"]) {
  const f = await pharmacyRetailFixture(permissions);
  const customer = identified ? await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Recorded customer", normalizedName: "recorded customer", address: "Actual address", kinds: ["customer"], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id }) : null;
  const sale = await app.inject({ method: "POST", url: "/api/pharmacy/sales", headers: { ...f.headers, "idempotency-key": key() }, payload: { ...f.input, ...(customer ? { customerId: customer.id, expectedCustomerRevision: 0 } : {}) } });
  expect(sale.statusCode, sale.body).toBe(201);
  return { ...f, invoiceId: sale.json().data.invoiceId as string };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = (f: Fixture, amountPaise = 2000, extra = {}) => ({ locationId: f.locationId, expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: amountPaise,
  entries: [{ componentId: key(), amountPaise, paymentMethod: "cash" }], ...extra });
const collect = (f: Fixture, body: object = input(f), requestKey = key(), full = false) => app.inject({ method: "POST", url: `/api/pharmacy/invoices/${f.invoiceId}/${full ? "pay" : "collections"}`, headers: { ...f.headers, "idempotency-key": requestKey }, payload: body });
const recover = (f: Fixture, requestKey: string) => app.inject({ method: "GET", url: `/api/pharmacy/collection-operations/${requestKey}?locationId=${f.locationId}`, headers: f.headers });

describe("Explicit pharmacy collections with exact-money shared mutation", () => {
  it("records split cash/UPI/card on one immutable receipt, computes cash change and contributes each method to till", async () => {
    const f = await fixture(), body = input(f, 500, { cashTenderedPaise: 1000, entries: [
      { componentId: key(), amountPaise: 500, paymentMethod: "cash" }, { componentId: key(), amountPaise: 700, paymentMethod: "upi", referenceNumber: "ACTUAL-UPI-REFERENCE" }, { componentId: key(), amountPaise: 800, paymentMethod: "card", referenceNumber: "ACTUAL-TERMINAL-REFERENCE" },
    ] }), requestKey = key(), response = await collect(f, body, requestKey);
    expect(response.statusCode, response.body).toBe(201); expect(response.headers["cache-control"]).toBe("no-store");
    const receipt = response.json().data;
    expect(receipt).toMatchObject({ invoiceId: f.invoiceId, collectedPaise: 2000, paidPaise: 2000, balancePaise: 0, cashTenderedPaise: 1000, cashChangePaise: 500, revision: 1, actorId: f.user.id, status: "paid", evidenceMode: "staff_confirmed_manual", requestKey });
    const invoice = await Invoice.findById(f.invoiceId);
    expect(invoice).toMatchObject({ amountPaid: 20, balanceDue: 0, status: "paid", paymentRevision: 1 }); expect(invoice.payments).toHaveLength(3);
    expect(new Set(invoice.payments.map((row: any) => row.operationKey)).size).toBe(3); expect(invoice.payments.every((row: any) => String(row.receiptId) === receipt.receiptId && String(row.actorId) === f.user.id)).toBe(true);
    const till = await collectTillReceipts(f.organizationId, f.locationId);
    expect(till.systemTotals).toMatchObject({ cash: 5, upi: 7, card: 8, total: 20, receiptCount: 3 }); expect(till.reconciliation.requiresReview).toBe(false);
    await expect(InvoiceCollectionReceipt.updateOne({ _id: receipt.receiptId }, { $set: { collectedPaise: 1 } })).rejects.toThrow(/append-only/);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(8);
  });
  it("supports identified partial credit followed by full settlement; replay preserves the original receipt after later payments", async () => {
    const f = await fixture(), body = input(f, 700), requestKey = key();
    const first = await collect(f, body, requestKey); expect(first.statusCode, first.body).toBe(201); expect(first.json().data).toMatchObject({ status: "partially_paid", collectedPaise: 700, balancePaise: 1300 });
    const rest = await collect(f, input(f, 1300, { expectedPaymentRevision: 1, expectedBalancePaise: 1300 }), key(), true); expect(rest.statusCode, rest.body).toBe(201); expect(rest.json().data.status).toBe("paid");
    expect((await collect(f, body, requestKey)).json().data).toEqual({ ...first.json().data, replayed: true });
    const { replayed: _replayed, ...snapshot } = first.json().data; expect((await recover(f, requestKey)).json().data).toEqual(snapshot);
    expect(await InvoiceCollectionReceipt.countDocuments({ invoiceId: f.invoiceId })).toBe(2);
  });
  it("requires anonymous/full-pay commands to settle the full balance and never creates a fake credit payment", async () => {
    const f = await fixture(false); expect((await collect(f, input(f, 1000))).statusCode).toBe(409); expect((await collect(f, input(f))).statusCode).toBe(201);
    const identified = await fixture(); expect((await collect(identified, input(identified, 1000), key(), true)).statusCode).toBe(409);
    expect((await collect(identified, input(identified, 0))).statusCode).toBe(400); expect((await Invoice.findById(identified.invoiceId)).amountPaid).toBe(0);
  });
  it("concurrent same-key calls record one receipt and different-key calls cannot overcollect", async () => {
    const f = await fixture(), body = input(f), requestKey = key();
    const same = await Promise.all([collect(f, body, requestKey), collect(f, body, requestKey)]); expect(same.map(row => row.statusCode)).toEqual([201, 201]); expect(same[0].json().data.receiptId).toBe(same[1].json().data.receiptId);
    const other = await fixture(), different = await Promise.all([collect(other), collect(other)]); expect(different.map(row => row.statusCode).sort()).toEqual([201, 409]);
    expect(await InvoiceCollectionReceipt.countDocuments({ invoiceId: other.invoiceId })).toBe(1); expect((await Invoice.findById(other.invoiceId)).amountPaid).toBe(20);
  });
  it("refuses new-key overpayment by even one paise, stale revisions/balances, changed committed input and corrupt ledger", async () => {
    const f = await fixture(); expect((await collect(f, input(f, 2001))).statusCode).toBe(409);
    expect((await collect(f, input(f, 1000, { expectedPaymentRevision: 1 }))).statusCode).toBe(409); expect((await collect(f, input(f, 1000, { expectedBalancePaise: 1999 }))).statusCode).toBe(409);
    const body = input(f, 1000), requestKey = key(); expect((await collect(f, body, requestKey)).statusCode).toBe(201);
    expect((await collect(f, { ...body, cashTenderedPaise: 1001 }, requestKey)).statusCode).toBe(409);
    await Invoice.updateOne({ _id: f.invoiceId }, { $set: { amountPaid: 11, balanceDue: 9 } });
    expect((await collect(f, input(f, 900, { expectedPaymentRevision: 1, expectedBalancePaise: 900 }))).statusCode).toBe(409);
  });
  it("required receipt audit failure rolls back the invoice, receipt, command and balance", async () => {
    const f = await fixture(), requestKey = key(), create = AuditLog.create.bind(AuditLog);
    const spy = vi.spyOn(AuditLog, "create").mockImplementation(((rows: any, ...args: any[]) => { if ((Array.isArray(rows) ? rows[0] : rows).action === "PHARMACY_INVOICE_COLLECTION") throw new Error("Synthetic audit failure"); return (create as any)(rows, ...args); }) as any);
    try { expect((await collect(f, input(f), requestKey)).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect((await Invoice.findById(f.invoiceId))).toMatchObject({ amountPaid: 0, balanceDue: 20, paymentRevision: 0 }); expect(await InvoiceCollectionReceipt.countDocuments({ invoiceId: f.invoiceId })).toBe(0); expect(await OperationReceipt.exists({ key: requestKey })).toBeNull();
    expect((await collect(f, input(f), requestKey)).statusCode).toBe(201);
  });
  it("requires collection grant, tenant/branch ownership, current actor and nonconsumer authority", async () => {
    const f = await fixture(), requestKey = key(); expect((await collect(f, input(f), requestKey)).statusCode).toBe(201);
    const other = await fixture(); expect((await collect({ ...other, invoiceId: f.invoiceId })).statusCode).toBe(404);
    const user = await User.create({ name: "Other operator", role: f.role, email: `${key()}@example.test` }); await OrgMember.create({ organizationId: f.organizationId, userId: user.id, role: f.role, locationAccess: { mode: "all", locationIds: [] } });
    const auth = await createAuthSession({ id: user.id, role: f.role, email: user.email!, organization_id: f.organizationId }); expect((await recover({ ...f, headers: { authorization: `Bearer ${auth.accessToken}` } }, requestKey)).statusCode).toBe(404);
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: ["PHARMACY_SELL"] } }); expect((await collect(f)).statusCode).toBe(403); expect((await recover(f, requestKey)).statusCode).toBe(200);
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { $set: { permissions: ["MANAGE_BILLING"] } }); expect((await recover(f, requestKey)).statusCode).toBe(403);
    const consumer = await User.create({ name: "Consumer", role: "patient", email: `${key()}@example.test` }), token = await createAuthSession({ id: consumer.id, role: "patient", email: consumer.email!, organization_id: f.organizationId });
    expect((await collect({ ...f, headers: { authorization: `Bearer ${token.accessToken}` } })).statusCode).toBe(403);
  });
  it("preserves recovery/history after disable, but blocks new money commands", async () => {
    const f = await fixture(), requestKey = key(); await collect(f, input(f, 1000), requestKey);
    await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": false } });
    expect((await collect(f, input(f, 1000, { expectedPaymentRevision: 1, expectedBalancePaise: 1000 }))).statusCode).toBe(409); expect((await recover(f, requestKey)).statusCode).toBe(200);
    const history = await app.inject({ method: "GET", url: `/api/pharmacy/invoices/${f.invoiceId}/collections?locationId=${f.locationId}`, headers: f.headers }); expect(history.statusCode).toBe(200); expect(history.json().data.items).toHaveLength(1);
  });
  it.each(["cancelled", "refunded"])("refuses money on %s invoices", async status => {
    const f = await fixture(); await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(f.invoiceId) }, { $set: { status } });
    expect((await collect(f)).statusCode).toBe(409); expect(await InvoiceCollectionReceipt.countDocuments({ invoiceId: f.invoiceId })).toBe(0);
  });
  it.each([
    { manualConfirmed: false }, { manualConfirmed: "true" }, { cashTenderedPaise: null }, { cashTenderedPaise: 1999 },
    ...[0, -1, 0.5, null, "2000", Number.MAX_SAFE_INTEGER + 1].map(amountPaise => ({ entries: [{ componentId: "component-1", amountPaise, paymentMethod: "cash" }] })),
    { entries: [{ componentId: "component-1", amountPaise: 2000, paymentMethod: "upi" }] },
    { entries: [{ componentId: "component-1", amountPaise: 2000, paymentMethod: "online", referenceNumber: "QR-ONLY" }] },
    { paidAt: "2026-10-01" }, { actorId: "arbitrary" }, { shiftId: new mongoose.Types.ObjectId().toString() },
  ])("rejects invalid evidence, money or forged authority %#", async patch => {
    const f = await fixture(); expect((await collect(f, input(f, 2000, patch))).statusCode).toBe(400); expect((await Invoice.findById(f.invoiceId)).amountPaid).toBe(0);
  });
  it("clinical full-pay reuses exact money/idempotency, shares remaining balance with installments and rolls back audits", async () => {
    const f = await pharmacyRetailFixture(["MANAGE_BILLING", "VIEW_BILLING"]), patient = await Patient.create({ organizationId: f.organizationId, name: "Clinical patient" });
    const invoice = await Invoice.create({ organizationId: f.organizationId, locationId: f.locationId, patientId: patient._id, doctorId: f.user.id, invoiceNumber: `CLINICAL-${key()}`, totalAmount: 10.23, subtotal: 10.23, currency: "INR", items: [{ description: "Clinical", amount: 10.23, quantity: 1 }], status: "unpaid", amountPaid: 0, balanceDue: 10.23 });
    const partial = await app.inject({ method: "POST", url: `/api/invoices/${invoice.id}/payments`, headers: { ...f.headers, "idempotency-key": key() }, payload: { amount: 0.23, paymentMethod: "cash", notes: "Actual clinical receipt note" } }); expect(partial.statusCode, partial.body).toBe(200);
    const requestKey = key(), full = () => app.inject({ method: "PUT", url: `/api/invoices/${invoice.id}/pay`, headers: { ...f.headers, "idempotency-key": requestKey }, payload: { paymentMethod: "cash" } });
    const create = AuditLog.create.bind(AuditLog), spy = vi.spyOn(AuditLog, "create").mockImplementation(((rows: any, ...args: any[]) => { if ((Array.isArray(rows) ? rows[0] : rows).action === "INVOICE_PAY") throw new Error("Synthetic audit failure"); return (create as any)(rows, ...args); }) as any);
    try { expect((await full()).statusCode).toBe(500); } finally { spy.mockRestore(); }
    expect((await Invoice.findById(invoice.id)).amountPaid).toBe(0.23);
    const first = await full(); expect(first.statusCode, first.body).toBe(200); expect((await full()).json().data).toEqual(first.json().data);
    const saved = await Invoice.findById(invoice.id); expect(saved.amountPaid).toBe(10.23); expect(saved.balanceDue).toBe(0); expect(saved.payments.map((entry: any) => entry.amount)).toEqual([0.23, 10]);
    expect(saved.payments[0].notes).toBe("Actual clinical receipt note");
    const withoutKey = await app.inject({ method: "PUT", url: `/api/invoices/${invoice.id}/pay`, headers: f.headers, payload: { paymentMethod: "cash" } }); expect(withoutKey.statusCode).toBe(428);
    const racing = await Invoice.create({ organizationId: f.organizationId, locationId: f.locationId, patientId: patient._id, doctorId: f.user.id, invoiceNumber: `CLINICAL-${key()}`, totalAmount: 10.23, subtotal: 10.23, currency: "INR", items: [{ description: "Clinical race", amount: 10.23, quantity: 1 }], amountPaid: 0, balanceDue: 10.23 });
    const results = await Promise.all([
      app.inject({ method: "PUT", url: `/api/invoices/${racing.id}/pay`, headers: { ...f.headers, "idempotency-key": key() }, payload: { paymentMethod: "cash" } }),
      app.inject({ method: "POST", url: `/api/invoices/${racing.id}/payments`, headers: { ...f.headers, "idempotency-key": key() }, payload: { amount: 0.01, paymentMethod: "cash" } }),
    ]);
    expect(results[0].statusCode, results[0].body).toBe(200); expect([200, 400, 409]).toContain(results[1].statusCode);
    const final = await Invoice.findById(racing.id); expect(final.amountPaid).toBe(10.23); expect(final.payments.reduce((sum: number, entry: any) => sum + Math.round(entry.amount * 100), 0)).toBe(1023);
  });
});

import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { PharmacyOpeningBalance } from "../models/PharmacyOpeningBalance.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyDispense } from "../models/PharmacyDispense.ts";
import { Patient } from "../models/Patient.ts";
import { Doctor } from "../models/Doctor.ts";
import { Medicine } from "../models/Medicine.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
const post = (f: { headers: object }, path: string, payload: object, reference = key()) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": reference }, payload });
async function fixture(kind: "customer" | "supplier" = "customer") {
  const f = await pharmacyRetailFixture(["MANAGE_ORGANIZATION"]), party = await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Actual opening party", normalizedName: "actual opening party", address: "Actual source address", kinds: [kind], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
  return { ...f, party, body: { locationId: f.locationId, partyId: party.id, kind: `${kind}_due`, expectedPartyRevision: 0, amountPaise: 12345, sourceDate: "2026-10-19", sourceReference: "ACTUAL-DATED-SOURCE-001", reviewReference: "Actual opening review reference", confirmedSource: true } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const get = (f: Fixture, path: string) => app.inject({ method: "GET", url: `/api/pharmacy/${path}?locationId=${f.locationId}`, headers: f.headers });
async function create(f: Fixture, reference = key()) { const response = await post(f, "opening-balances", f.body, reference); expect(response.statusCode, response.body).toBe(201); return response.json().data; }
describe("Reviewed dated opening dues without current supply or duplicate incoming ledgers", () => {
  it("creates a clearly separate customer balance statement, collects it through Invoice.payments and makes no sale/clinical/stock effects", async () => {
    const f = await fixture(), stockBefore = await StockMovement.countDocuments({ medicineId: f.medicine.id }), source = await create(f), invoice = await Invoice.findById(source.invoiceId);
    expect(invoice).toMatchObject({ kind: "pharmacy", documentVersion: 3, openingBalanceId: expect.anything(), totalAmount: 123.45, taxableAmount: 0, tax: 0, items: [], balanceDue: 123.45, customerSnapshot: { anonymous: false, name: f.party.name } }); expect(invoice!.taxDocument).toBeUndefined(); expect(invoice!.calculation).toBeUndefined(); expect(await PharmacyDispense.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await Patient.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await Doctor.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect((await get(f, `invoices/${source.invoiceId}`)).statusCode).toBe(200); expect((await get(f, "return-invoices")).json().data.items).toHaveLength(0);
    for (const [amount, balance, revision] of [[4545, 12345, 0], [7800, 7800, 1]]) {
      const response = await post(f, `invoices/${source.invoiceId}/collections`, { locationId: f.locationId, expectedPaymentRevision: revision, expectedBalancePaise: balance, manualConfirmed: true, cashTenderedPaise: amount, entries: [{ componentId: key(), amountPaise: amount, paymentMethod: "cash" }] }); expect(response.statusCode, response.body).toBe(201);
    }
    const statement = (await get(f, `customers/${f.party.id}/statement`)).json().data; expect(statement.totals).toMatchObject({ totalPaise: 12345, paidPaise: 12345, duePaise: 0 }); expect(statement.invoices[0].documentVersion).toBe(3);
    expect((await Medicine.findById(f.medicine.id))!.stockQuantity).toBe(10); expect(await StockMovement.countDocuments({ medicineId: f.medicine.id })).toBe(stockBefore);
    const clinical = await app.inject({ method: "GET", url: `/api/invoices/${source.invoiceId}`, headers: f.headers }); expect(clinical.statusCode).toBeGreaterThanOrEqual(400);
  });
  it("keeps supplier opening dues separate from purchases and records allocated payments and actual credits", async () => {
    const f = await fixture("supplier"), source = await create(f), supplier = (await get(f, `suppliers/${f.party.id}/statement`)).json().data; expect(supplier.purchases).toEqual([]); expect(supplier.openingBalances).toMatchObject([{ openingBalanceId: source.openingBalanceId, duePaise: 12345 }]); expect(supplier.totals.openingDuePaise).toBe(12345);
    const base = { locationId: f.locationId, supplierId: f.party.id, manualConfirmed: true, reviewReference: "Actual confirmed settlement", amountPaise: 1000, paymentMethod: "bank", referenceNumber: key(), allocations: [{ openingBalanceId: source.openingBalanceId, amountPaise: 1000, expectedSettlementRevision: 0 }] };
    const paid = await post(f, "settlements/supplier-payment", base); expect(paid.statusCode, paid.body).toBe(201);
    const credit = await post(f, "settlements/supplier-credit", { ...base, paymentMethod: "none", sourceDate: "2026-10-20", referenceNumber: key(), allocations: [{ openingBalanceId: source.openingBalanceId, amountPaise: 1000, expectedSettlementRevision: 1 }] }); expect(credit.statusCode, credit.body).toBe(201);
    expect((await get(f, `suppliers/${f.party.id}/statement`)).json().data.totals).toMatchObject({ payablePaise: 12345, paidPaise: 1000, confirmedCreditPaise: 1000, pendingCreditPaise: 0, duePaise: 10345 }); expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("replays the same source and rejects duplicate actual source identity under another operation key", async () => {
    const f = await fixture(), reference = key(), source = await create(f, reference); expect((await create(f, reference)).openingBalanceId).toBe(source.openingBalanceId);
    expect((await post(f, "opening-balances", { ...f.body, sourceReference: f.body.sourceReference.toLowerCase() })).statusCode).toBe(409); expect(await PharmacyOpeningBalance.countDocuments({ organizationId: f.organizationId })).toBe(1); expect((await get(f, `opening-balance-operations/${reference}`)).json().data.openingBalanceId).toBe(source.openingBalanceId);
  });
  it("freezes opening evidence and protects the associated statement against edits and deletion", async () => {
    const f = await fixture(), source = await create(f), row = (await PharmacyOpeningBalance.findById(source.openingBalanceId))!; row.amountPaise = 1; await expect(row.save()).rejects.toThrow(/immutable/);
    await expect(PharmacyOpeningBalance.deleteOne({ _id: source.openingBalanceId })).rejects.toThrow(/guarded/); await expect(Invoice.updateOne({ _id: source.invoiceId }, { $set: { totalAmount: 1 } })).rejects.toThrow(/rewritten/); await expect(Invoice.deleteOne({ _id: source.invoiceId })).rejects.toThrow(/rewritten/);
  });
  it("does not consume the retail invoice sequence or create a tax invoice for an opening statement", async () => {
    const f = await fixture(), source = await create(f); expect(source.statementNumber.startsWith("O")).toBe(true); const sale = await post(f, "sales", f.input); expect(sale.statusCode, sale.body).toBe(201); expect(sale.json().data.invoiceNumber).toMatch(/^I[A-Z0-9]{4}[0-9]{4}\/000001$/);
  });
  it("rolls back opening source, statement and numbering on required audit failure", async () => {
    const f = await fixture(), createAudit = AuditLog.create.bind(AuditLog), spy = vi.spyOn(AuditLog, "create").mockImplementation(((docs: any, ...args: any[]) => { if ((Array.isArray(docs) ? docs[0] : docs).action === "PHARMACY_OPENING_BALANCE_RECORDED") throw new Error("Synthetic opening audit failure"); return (createAudit as any)(docs, ...args); }) as any);
    try { expect((await post(f, "opening-balances", f.body)).statusCode).toBe(500); } finally { spy.mockRestore(); } expect(await PharmacyOpeningBalance.countDocuments({ organizationId: f.organizationId })).toBe(0); expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0); const source = await create(f); expect(source.statementNumber).toMatch(/\/000001$/);
  });
  it("requires organization management and current party authority/revision", async () => {
    const f = await fixture(), foreign = await fixture(); expect((await post(f, "opening-balances", { ...f.body, partyId: foreign.party.id })).statusCode).toBe(409); expect((await post(f, "opening-balances", { ...f.body, expectedPartyRevision: 1 })).statusCode).toBe(409); await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_APPROVE_REFUND"] } }); expect((await post(f, "opening-balances", f.body)).statusCode).toBe(403);
  });
  it.each([{ confirmedSource: false }, { amountPaise: "12345" }, { amountPaise: 0 }, { amountPaise: -1 }, { sourceDate: "2099-01-01" }, { status: "paid" }, { currency: "USD" }, { actorId: "forged" }])("rejects unreviewed/invalid or fabricated source fields %j", async extra => {
    const f = await fixture(); expect((await post(f, "opening-balances", { ...f.body, ...extra })).statusCode).toBe(400); expect(await PharmacyOpeningBalance.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
});

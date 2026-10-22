import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { pharmacyPurchaseFixture } from "./helpers/pharmacyPurchaseFixture.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Role } from "../models/Role.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyPurchase } from "../models/PharmacyPurchase.ts";
import { PharmacyCashEvent } from "../models/PharmacyCashEvent.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { lotExpiry } from "../utilities/pharmacyLot.ts";
import { pharmacyReportKinds } from "../schemas/pharmacyReports.ts";
const key = () => crypto.randomUUID();
const grants = ["PHARMACY_VIEW_REPORTS", "PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_COST", "PHARMACY_SELL", "PHARMACY_COLLECT_PAYMENT", "PHARMACY_PURCHASE", "PHARMACY_RETURN", "PHARMACY_APPROVE_REFUND", "PHARMACY_CLOSE_TILL", "MANAGE_ORGANIZATION"];
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
type Scope = { locationId: string; headers: Record<string, string> };
const get = (f: Scope, kind: string, extra = "") => app.inject({ method: "GET", url: `/api/pharmacy/reports/${kind}?locationId=${f.locationId}${extra}`, headers: f.headers });
const post = (f: Scope, path: string, body: object) => app.inject({ method: "POST", url: `/api/pharmacy/${path}`, headers: { ...f.headers, "idempotency-key": key() }, payload: { locationId: f.locationId, ...body } });
const fixture = (permissions = grants) => pharmacyRetailFixture(permissions);
async function read(f: Scope, kind: string, extra = "") { const res = await get(f, kind, extra); expect(res.statusCode, res.body).toBe(200); return res.json().data; }
async function issue(f: Awaited<ReturnType<typeof fixture>>) { const res = await post(f, "sales", f.input); expect(res.statusCode, res.body).toBe(201); return res.json().data.invoiceId; }
async function collect(f: Scope, id: string) { const res = await post(f, `invoices/${id}/collections`, { expectedPaymentRevision: 0, expectedBalancePaise: 2000, manualConfirmed: true, cashTenderedPaise: 1000, entries: [{ componentId: "cash-component", amountPaise: 1000, paymentMethod: "cash" }, { componentId: "upi-component", amountPaise: 1000, paymentMethod: "upi", referenceNumber: "ACTUAL-UPI-REPORT" }] }); expect(res.statusCode, res.body).toBe(201); }
describe("Bounded source-based pharmacy reports and reviewed CSV", () => {
  it("reports captured stock and rational lot cost without adding unlike units or leaking acquisition costs", async () => {
    const f = await fixture(), stock = await read(f, "stock"), value = await read(f, "valuation");
    expect(stock.rows[0]).toMatchObject({ product: "Ordinary product", units: 10, eligible: 10, unit: "tablet", reorder: 20, review: "" });
    expect(JSON.stringify(stock)).not.toMatch(/costBasis|purchaseCost|purchaseTotalPaise|valueFloorPaise/); expect(stock.totals).toEqual({});
    expect(value.rows[0]).toMatchObject({ units: 10, saleable: 10, valueFloorPaise: 101, costNumerator: "1010", costDenominator: 10 }); expect(value.totals.valueFloorPaise).toBe(101); expect(value.totalScope).toBe("page");
    await issue(f); const after = await read(f, "valuation"); expect(after.rows[0]).toMatchObject({ units: 8, valueFloorPaise: 80, costNumerator: "808", costDenominator: 10 });
  });
  it("uses saleable units for low stock, retains expiry precision, and excludes zero on-hand expiry lots", async () => {
    const f = await fixture(), lot = (await MedicineBatch.findOne({ medicineId: f.medicine.id }))!;
    await Medicine.updateOne({ _id: f.medicine.id }, { $set: { reorderLevel: 1 } }); expect((await read(f, "low_stock")).rows).toEqual([]);
    const expiry = lotExpiry({ precision: "month", value: "2020-01" }, "Asia/Kolkata");
    await MedicineBatch.collection.updateOne({ _id: lot._id }, { $set: { expiryDate: expiry.cutoff, expirySnapshot: expiry, receivedAt: new Date("2019-01-01T00:00:00Z") } });
    const low = await read(f, "low_stock"); expect(low.rows[0]).toMatchObject({ units: 10, eligible: 0, reorder: 1 });
    const expired = await read(f, "expiry"); expect(expired.rows[0]).toMatchObject({ printedExpiry: "2020-01", saleable: 0, units: 10 });
    await MedicineBatch.collection.updateOne({ _id: lot._id }, { $set: { quantity: 0 } }); expect((await read(f, "expiry")).rows).toEqual([]);
  });
  it("marks missing or corrupt unit/cost/aggregate evidence unknown instead of inventing saleable stock or zero value", async () => {
    const f = await fixture(); await Medicine.updateOne({ _id: f.medicine.id }, { $set: { stockQuantity: 11 } });
    expect((await read(f, "low_stock")).rows[0]).toMatchObject({ eligible: null, review: expect.stringMatching(/review/) });
    await MedicineBatch.collection.updateOne({ medicineId: new mongoose.Types.ObjectId(f.medicine.id) }, { $unset: { costBasis: "" } });
    const page = await read(f, "valuation"); expect(page.rows[0].valueFloorPaise).toBeNull(); expect(page.totals.valueFloorPaise).toBeNull();
  });
  it("distinguishes old never-supplied stock from newly received stock in the dead-stock report", async () => {
    const f = await fixture(); expect((await read(f, "dead_stock")).rows).toEqual([]);
    await MedicineBatch.collection.updateOne({ medicineId: new mongoose.Types.ObjectId(f.medicine.id) }, { $set: { receivedAt: new Date(Date.now() - 100 * 86400000) } });
    expect((await read(f, "dead_stock")).rows[0].movementBasis).toBe("No dispense in 90 days");
    await issue(f); expect((await read(f, "dead_stock")).rows).toEqual([]);
  });
  it("separates supply, source tax and actual split collections, including current due and source movements", async () => {
    const f = await fixture(), invoiceId = await issue(f); expect((await read(f, "customer_dues")).rows[0].duePaise).toBe(2000); await collect(f, invoiceId);
    const sales = await read(f, "sales"), receipts = await read(f, "collections"), tax = await read(f, "tax");
    expect(sales.rows[0]).toMatchObject({ totalPaise: 2000, paidPaise: 2000, duePaise: 0 }); expect(receipts.rows).toHaveLength(2); expect(receipts.rows.map((row: any) => row.method).sort()).toEqual(["cash", "upi"]); expect(receipts.totals.receivedPaise).toBe(2000);
    expect(tax.rows[0]).toMatchObject({ payablePaise: 2000, cgstPaise: 0, sgstPaise: 0 }); expect((await read(f, "customer_dues")).rows).toEqual([]);
    expect((await read(f, "movements")).rows.some((row: any) => row.kind === "dispense" && row.delta === -2 && row.before === 10 && row.after === 8)).toBe(true);
  });
  it("includes reviewed opening customer debt in dues and receipts but excludes it from supplies and tax", async () => {
    const f = await fixture(), party = await post(f, "parties", { name: "Actual customer", address: "Actual address", kinds: ["customer"], gstRegistration: "unregistered" }); expect(party.statusCode, party.body).toBe(201);
    const opening = await post(f, "opening-balances", { kind: "customer_due", partyId: party.json().data.id, expectedPartyRevision: 0, amountPaise: 1000, sourceDate: "2026-10-20", sourceReference: key(), confirmedSource: true, reviewReference: "Actual dated opening review" }); expect(opening.statusCode, opening.body).toBe(201);
    const due = await read(f, "customer_dues"); expect(due.rows[0]).toMatchObject({ document: "Opening debt statement", duePaise: 1000 }); expect((await read(f, "sales")).rows).toEqual([]); expect((await read(f, "tax")).rows).toEqual([]);
  });
  it("reports posted supplier bills, actual payments, pending credits and opening dues without conflating them", async () => {
    const f = await pharmacyPurchaseFixture(grants), purchaseId = f.purchase.id;
    const posted = await post(f, `purchases/${purchaseId}/post`, { expectedRevision: 0, expectedSupplierRevision: 0, supplierStateCode: "27", taxMode: "sgst", costTreatment: "exclude_tax", roundOffPaise: 0, reviewReference: "Synthetic actual bill review" }); expect(posted.statusCode, posted.body).toBe(200);
    expect((await read(f, "purchases")).totals.payablePaise).toBe(118);
    const payment = await post(f, "settlements/supplier-payment", { supplierId: f.party.id, amountPaise: 100, paymentMethod: "bank", referenceNumber: key(), reviewReference: "Actual supplier payment", manualConfirmed: true, allocations: [{ purchaseId, amountPaise: 100, expectedSettlementRevision: 0 }] }); expect(payment.statusCode, payment.body).toBe(201);
    expect((await read(f, "supplier_dues")).rows[0]).toMatchObject({ payablePaise: 118, paidPaise: 100, duePaise: 18, pendingCreditPaise: 0 });
    const opening = await post(f, "opening-balances", { kind: "supplier_due", partyId: f.party.id, expectedPartyRevision: 0, amountPaise: 200, sourceDate: "2026-10-20", sourceReference: key(), confirmedSource: true, reviewReference: "Actual supplier opening due" }); expect(opening.statusCode, opening.body).toBe(201);
    const bills = await read(f, "supplier_dues"); expect(bills.nextCursor).toBe("o:start"); const openings = await read(f, "supplier_dues", "&cursor=o:start"); expect(openings.rows[0]).toMatchObject({ source: "Opening due", duePaise: 200 });
    const cash = await read(f, "cash_events"); expect(cash.rows[0]).toMatchObject({ kind: "supplier_payment", outPaise: 100, inPaise: 0 }); expect(cash.totals).toEqual({ inPaise: 0, outPaise: 100 });
  });
  it("requires both report and source grants, independently requires cost visibility, and supports basic stock alerts", async () => {
    const f = await fixture(["PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_REPORTS"]); expect((await get(f, "stock")).statusCode).toBe(200); for (const kind of ["valuation", "sales", "collections", "supplier_dues", "tax", "cash_events"]) expect((await get(f, kind)).statusCode).toBe(403);
    await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_VIEW_STOCK"] } }); expect((await get(f, "stock")).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/stock-alerts/low_stock?locationId=${f.locationId}`, headers: f.headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/stock-alerts/valuation?locationId=${f.locationId}`, headers: f.headers })).statusCode).toBe(403);
  });
  it("hides financial-source and billing-domain cash events from unrelated pharmacy report roles", async () => {
    const f = await fixture(), at = new Date(), common = { organizationId: f.organizationId, locationId: f.locationId, actorId: f.user.id, shiftId: new mongoose.Types.ObjectId(), drawerCode: "REAL", drawerOwnerId: f.user.id, kind: "cash_in" as const, direction: "in" as const, amountPaise: 101, currency: "INR" as const, paymentMethod: "cash" as const, referenceNumber: key(), normalizedReference: key(), financialYear: "2026-27", reviewReference: "Actual cash count", evidenceMode: "staff_confirmed_manual" as const, operationKey: key(), recordedAt: at, allocations: [] };
    await PharmacyCashEvent.create({ ...common, domain: "billing" }); expect((await read(f, "cash_events")).rows).toEqual([]);
    await PharmacyCashEvent.create({ ...common, domain: "pharmacy", referenceNumber: key(), normalizedReference: key(), operationKey: key() }); expect((await read(f, "cash_events")).totals.inPaise).toBe(101);
  });
  it("isolates branches and rejects unknown reports, forged ownership, unbounded dates, malformed cursors and page sizes", async () => {
    const f = await fixture(), other = await fixture(); expect((await get({ ...f, locationId: other.locationId }, "stock")).statusCode).toBe(404);
    for (const extra of ["&limit=0", "&limit=26", "&limit=1.5", "&days=366", "&days=-1", "&cursor=bad", "&startDate=2026-01-01", "&startDate=2026-01-01&endDate=2026-10-20", "&startDate=2026-02-30&endDate=2026-03-01", "&startDate=2099-01-01&endDate=2099-01-02", "&columns=costBasis"]) expect((await get(f, "stock", extra)).statusCode).toBe(400);
    for (const kind of ["toString", "constructor", "unknown"]) expect((await get(f, kind)).statusCode).toBe(400);
    expect((await get(f, "stock", `&organizationId=${other.organizationId}`)).statusCode).toBe(403);
  });
  it("returns only authorized catalogue choices and retains report continuity after pharmacy capability disable", async () => {
    const f = await fixture(["PHARMACY_VIEW_REPORTS", "PHARMACY_VIEW_STOCK"]), catalogue = await app.inject({ method: "GET", url: `/api/pharmacy/reports?locationId=${f.locationId}`, headers: f.headers }); expect(catalogue.statusCode).toBe(200); expect(catalogue.json().data.items.map((row: any) => row.kind)).not.toContain("valuation");
    await Location.updateOne({ _id: f.locationId }, { $set: { "pharmacyCapability.enabled": false } }); expect((await get(f, "stock")).statusCode).toBe(200);
  });
  it("exports only the reviewed page, neutralizes formulas/CR and requires transactional audit", async () => {
    const f = await fixture(); await Medicine.updateOne({ _id: f.medicine.id }, { $set: { name: '=HYPERLINK("evil")\rActual product' } }); const page = await read(f, "stock");
    expect((await get(f, "stock/export")).statusCode).toBe(428);
    const exported = await get(f, "stock/export", `&expectedDigest=${page.digest}`); expect(exported.statusCode, exported.body).toBe(200); expect(exported.headers["content-type"]).toMatch(/text\/csv/); expect(exported.headers["x-report-digest"]).toBe(page.digest); expect(exported.body).toContain('"\'=HYPERLINK(""evil"")\rActual product"'); expect(await AuditLog.countDocuments({ organizationId: f.organizationId, action: "PHARMACY_REPORT_EXPORTED" })).toBe(1);
    const spy = vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable")); try { const failed = await get(f, "stock/export", `&expectedDigest=${page.digest}`); expect(failed.statusCode).toBe(500); expect(failed.headers["content-type"]).not.toContain("text/csv"); } finally { spy.mockRestore(); }
  });
  it("rejects export after source changes or permission revocation without returning stale sensitive data", async () => {
    const f = await fixture(), page = await read(f, "valuation"); await issue(f);
    expect((await get(f, "valuation/export", `&expectedDigest=${page.digest}`)).statusCode).toBe(409); expect(await AuditLog.countDocuments({ organizationId: f.organizationId, action: "PHARMACY_REPORT_EXPORTED" })).toBe(0);
    const fresh = await read(f, "valuation"); await Role.updateOne({ organizationId: f.organizationId, name: f.role }, { $set: { permissions: ["PHARMACY_VIEW_REPORTS", "PHARMACY_VIEW_STOCK"] } }); expect((await get(f, "valuation/export", `&expectedDigest=${fresh.digest}`)).statusCode).toBe(403);
  });
  it("pages primary sources, declares page subtotals, and keeps all empty report contracts usable", async () => {
    const f = await fixture(); await Medicine.create({ locationId: f.locationId, name: "Other product", genericName: "Synthetic", price: 1, stockQuantity: 0, unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } });
    const first = await read(f, "stock", "&limit=1"); expect(first.scanned).toBe(1); expect(first.rows).toHaveLength(1); expect(first.nextCursor).toMatch(/^[a-f\d]{24}$/); const next = await read(f, "stock", `&limit=1&cursor=${first.nextCursor}`); expect(next.rows[0].id).not.toBe(first.rows[0].id); expect(next.nextCursor).toBeNull();
    for (const kind of pharmacyReportKinds) { const page = await read(f, kind); expect(page).toMatchObject({ kind, locationId: f.locationId, totalScope: "page", limit: 25 }); expect(page.columns.length).toBeGreaterThan(0); expect(page.digest).toMatch(/^[a-f\d]{64}$/); }
  });
  it.each(["patient", "family_member", "guest"])("denies consumer role %s even with report and stock grants", async role => {
    const f = await fixture(); await Role.create({ organizationId: f.organizationId, name: role, permissions: grants });
    const user = await User.create({ name: "Synthetic consumer", email: `${key()}@example.test`, role }); await OrgMember.create({ organizationId: f.organizationId, userId: user.id, role, locationAccess: { mode: "selected", locationIds: [f.locationId] } });
    const auth = await createAuthSession({ id: user.id, role, email: user.email!, organization_id: f.organizationId }); expect((await get({ ...f, headers: { authorization: `Bearer ${auth.accessToken}` } }, "stock")).statusCode).toBe(403);
  });
  it("records the real billing origin of cash movements while preserving shared drawer reconciliation", async () => {
    const f = await fixture([...grants, "MANAGE_BILLING"]), drawer = (await CashierShift.findOne({ organizationId: f.organizationId, kind: "drawer", status: "active" }))!;
    const moved = await app.inject({ method: "POST", url: `/api/billing/till/drawers/${drawer.id}/movements`, headers: { ...f.headers, "idempotency-key": key() }, payload: { locationId: f.locationId, expectedRevision: 0, direction: "in", amountPaise: 101, referenceNumber: key(), reviewReference: "Actual clinical drawer cash" } }); expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json().data.drawer.drawerTotals.expectedCashPaise).toBe(100101); expect((await PharmacyCashEvent.findOne({ shiftId: drawer._id }))!.domain).toBe("billing"); expect((await read(f, "cash_events")).rows).toEqual([]);
  });
  it("cross-checks immutable collection receipts against the actual invoice components", async () => {
    const f = await fixture(), invoiceId = await issue(f); await collect(f, invoiceId); expect((await read(f, "collections")).totals.receivedPaise).toBe(2000);
    await Invoice.collection.updateOne({ _id: new mongoose.Types.ObjectId(invoiceId) }, { $set: { "payments.0.actorId": new mongoose.Types.ObjectId() } }); expect((await get(f, "collections")).statusCode).toBe(409);
  });
  it("reconciles source credits, quarantine valuation and actual refunds without reducing original supply or gross receipts", async () => {
    const f = await fixture(), invoiceId = await issue(f); await collect(f, invoiceId);
    const source = (await app.inject({ method: "GET", url: `/api/pharmacy/invoices/${invoiceId}/return-source?locationId=${f.locationId}`, headers: f.headers })).json().data.lines[0];
    const quote = await post(f, `invoices/${invoiceId}/returns/quote`, { reason: "Actual unopened return", reviewReference: "Source credit reviewed", confirmedQuarantine: true, lines: [{ sourceLineId: source.sourceLineId, sourceBatchId: source.sourceBatchId, quantity: 1, condition: "unopened" }] }); expect(quote.statusCode, quote.body).toBe(200);
    const returned = await post(f, `invoices/${invoiceId}/returns`, quote.json().data.issueInput); expect(returned.statusCode, returned.body).toBe(201);
    expect((await read(f, "sales_returns")).totals.creditPaise).toBe(1000); expect((await read(f, "collections")).totals.receivedPaise).toBe(2000); expect((await read(f, "tax")).totals.payablePaise).toBe(2000);
    expect((await read(f, "stock")).rows[0]).toMatchObject({ units: 9, eligible: 8 }); const valuation = await read(f, "valuation"); expect(valuation.rows.find((row: any) => row.status === "quarantined")).toMatchObject({ units: 1, saleable: 0, valueFloorPaise: 10, costNumerator: "101", costDenominator: 10 });
    const invoice = await Invoice.findById(invoiceId), payout = await post(f, "settlements/customer-refund", { invoiceId, amountPaise: 400, paymentMethod: "cash", referenceNumber: key(), reviewReference: "Actual confirmed payout", manualConfirmed: true, expectedPaymentRevision: invoice.paymentRevision, expectedRefundPayablePaise: 1000 }); expect(payout.statusCode, payout.body).toBe(201);
    expect((await read(f, "customer_dues")).rows[0]).toMatchObject({ duePaise: 0, refundedPaise: 400, refundPayablePaise: 600 }); expect((await read(f, "cash_events")).totals).toEqual({ inPaise: 0, outPaise: 400 });
    const drawer = await app.inject({ method: "GET", url: `/api/pharmacy/till?locationId=${f.locationId}`, headers: f.headers }); expect(drawer.json().data.active.drawerTotals.expectedCashPaise).toBe(100600);
  });
  it("keeps expected supplier return credit pending until actual credit evidence and never reports that document as cash", async () => {
    const f = await pharmacyPurchaseFixture([...grants, "PHARMACY_RECEIVE_STOCK"]), purchaseId = f.purchase.id;
    expect((await post(f, `purchases/${purchaseId}/post`, { expectedRevision: 0, expectedSupplierRevision: 0, supplierStateCode: "27", taxMode: "sgst", costTreatment: "exclude_tax", roundOffPaise: 0, reviewReference: "Actual supplier bill" })).statusCode).toBe(200);
    expect((await post(f, `purchases/${purchaseId}/receipts`, { expectedRevision: 1, deliveryReference: key(), lines: [{ lineId: key(), purchaseLineId: f.body.lines[0].lineId, billedBaseUnits: 3, freeBaseUnits: 1, batchNumber: "ACTUAL-RETURN", expiry: { precision: "month", value: "2099-12" } }] })).statusCode).toBe(201);
    const source = (await app.inject({ method: "GET", url: `/api/pharmacy/purchases/${purchaseId}/return-source?locationId=${f.locationId}`, headers: f.headers })).json().data.lines[0];
    const quote = await post(f, `purchases/${purchaseId}/returns/quote`, { reason: "Actual supplier return", reviewReference: "Actual returned goods review", lines: [{ receiptId: source.receiptId, receiptLineId: source.receiptLineId, quantity: 2 }] }); expect(quote.statusCode, quote.body).toBe(200); const returned = await post(f, `purchases/${purchaseId}/returns`, quote.json().data.issueInput); expect(returned.statusCode, returned.body).toBe(201);
    expect((await read(f, "purchase_returns")).totals.expectedCreditPaise).toBe(59); expect((await read(f, "supplier_dues")).rows[0]).toMatchObject({ duePaise: 118, pendingCreditPaise: 59, confirmedCreditPaise: 0 });
    const purchase = (await PharmacyPurchase.findById(purchaseId))!, credit = await post(f, "settlements/supplier-credit", { supplierId: f.party.id, amountPaise: 59, paymentMethod: "none", sourceDate: "2026-10-20", referenceNumber: key(), reviewReference: "Actual supplier credit note", manualConfirmed: true, allocations: [{ purchaseReturnId: returned.json().data.returnId, amountPaise: 59, expectedSettlementRevision: purchase.settlementRevision }] }); expect(credit.statusCode, credit.body).toBe(201);
    expect((await read(f, "supplier_dues")).rows[0]).toMatchObject({ duePaise: 59, confirmedCreditPaise: 59, pendingCreditPaise: 0 }); const cash = await read(f, "cash_events"); expect(cash.rows[0]).toMatchObject({ kind: "supplier_credit", direction: "none", inPaise: 0, outPaise: 0 }); expect(cash.totals).toEqual({ inPaise: 0, outPaise: 0 });
  });
  it("keeps product and related-lot reads bounded on a representative mixed-tenant dataset and reviews the query plan", async () => {
    const f = await fixture(), foreign = await fixture(), unitDefinition = { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 };
    await Medicine.collection.insertMany(Array.from({ length: 320 }, (_, index) => ({ locationId: new mongoose.Types.ObjectId(index < 160 ? foreign.locationId : f.locationId), name: `Synthetic report product ${index}`, genericName: "Synthetic", price: 1, stockQuantity: 0, reorderLevel: 0, unitDefinition, deletedAt: null })));
    const products = vi.spyOn(Medicine, "find"), lots = vi.spyOn(MedicineBatch, "find");
    try { const result = await read(f, "stock"); expect(result.scanned).toBe(25); expect(result.rows).toHaveLength(25); expect(result.nextCursor).not.toBeNull(); expect(products).toHaveBeenCalledOnce(); expect(lots).toHaveBeenCalledOnce(); expect(products.mock.results[0].value.getOptions().limit).toBe(26); expect(lots.mock.results[0].value.getOptions().limit).toBe(2001); } finally { products.mockRestore(); lots.mockRestore(); }
    const plan = await Medicine.collection.find({ locationId: new mongoose.Types.ObjectId(f.locationId), deletedAt: null }, { projection: { name: 1, stockQuantity: 1, reorderLevel: 1, unitDefinition: 1, createdAt: 1 } }).sort({ _id: 1 }).limit(26).explain("executionStats");
    expect(plan.executionStats.nReturned).toBe(26); expect(plan.executionStats.totalDocsExamined).toBeLessThanOrEqual(500); expect(JSON.stringify(plan.queryPlanner.winningPlan)).toMatch(/IXSCAN/);
    console.info("Synthetic pharmacy report explain", JSON.stringify({ products: 322, returned: plan.executionStats.nReturned, documentsExamined: plan.executionStats.totalDocsExamined, keysExamined: plan.executionStats.totalKeysExamined, milliseconds: plan.executionStats.executionTimeMillis }));
  });
  it("keeps the quick expiry route bounded and redacts rational acquisition cost without the cost grant", async () => {
    const f = await fixture(["PHARMACY_VIEW_STOCK"]), url = `/api/pharmacy/expiring?locationId=${f.locationId}&days=36500`;
    const first = await app.inject({ method: "GET", url, headers: f.headers }); expect(first.statusCode, first.body).toBe(200); expect(first.json().data).toHaveLength(1); expect(JSON.stringify(first.json().data)).not.toMatch(/purchaseCost|costBasis|purchaseSource/);
    const batches = await app.inject({ method: "GET", url: `/api/pharmacy/medicines/${f.medicine.id}/batches`, headers: f.headers }); expect(batches.statusCode, batches.body).toBe(200); expect(batches.json().data).toHaveLength(1); expect(JSON.stringify(batches.json().data)).not.toMatch(/purchaseCost|costBasis/);
    const source = (await MedicineBatch.findOne({ medicineId: f.medicine.id }).lean())!;
    await MedicineBatch.collection.insertMany(Array.from({ length: 100 }, () => ({ ...source, _id: new mongoose.Types.ObjectId(), receiptLineId: key() })));
    const bounded = await app.inject({ method: "GET", url, headers: f.headers }); expect(bounded.statusCode).toBe(409); expect(bounded.json().message).toMatch(/paginated/);
    for (const days of ["30junk", "36501", "-1", "1.5"]) expect((await app.inject({ method: "GET", url: `/api/pharmacy/expiring?locationId=${f.locationId}&days=${days}`, headers: f.headers })).statusCode).toBe(400);
  });
  it("exposes only the reviewed export digest to allowed browser origins and permits stable-key preflight", async () => {
    const f = await fixture(), page = await read(f, "stock"), origin = process.env.CORS_ALLOWED_ORIGINS?.split(",")[0].trim().replace(/\/+$/, "") || "http://localhost:3000";
    const exported = await app.inject({ method: "GET", url: `/api/pharmacy/reports/stock/export?locationId=${f.locationId}&expectedDigest=${page.digest}`, headers: { ...f.headers, origin } }); expect(exported.statusCode, exported.body).toBe(200); expect(String(exported.headers["access-control-expose-headers"]).toLowerCase()).toContain("x-report-digest");
    const preflight = await app.inject({ method: "OPTIONS", url: "/api/pharmacy/till/open", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "Idempotency-Key,Content-Type" } }); expect(preflight.statusCode).toBe(204); expect(String(preflight.headers["access-control-allow-headers"]).toLowerCase()).toContain("idempotency-key");
    const denied = await app.inject({ method: "OPTIONS", url: "/api/pharmacy/till/open", headers: { origin: "https://not-an-allowed-origin.example", "access-control-request-method": "POST" } }); expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

import crypto from "node:crypto";
import mongoose from "mongoose";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../index.ts";
import { pharmacyRetailFixture } from "./helpers/pharmacyRetailFixture.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { PharmacyImport } from "../models/PharmacyImport.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { Invoice } from "../models/Invoice.ts";
import { PharmacyOpeningBalance } from "../models/PharmacyOpeningBalance.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Role } from "../models/Role.ts";
import { Organization } from "../models/Organization.ts";
import { PHARMACY_IMPORT_FIELDS, type PharmacyImportKind } from "../schemas/pharmacyImports.ts";

const key = () => crypto.randomUUID();
beforeAll(async () => { await app.ready(); await Promise.all(Object.values(mongoose.models).map(model => model.init())); });
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const f = await pharmacyRetailFixture(["MANAGE_ORGANIZATION", "PHARMACY_MANAGE_CATALOG", "PHARMACY_RECEIVE_STOCK", "PHARMACY_VIEW_STOCK", "PHARMACY_VIEW_COST"]);
  const medicine = await Medicine.create({ locationId: f.locationId, name: "Empty explicit product", genericName: "Synthetic", price: 10,
    unitDefinition: { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 } });
  return { ...f, empty: medicine };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function request(f: Fixture, kind: PharmacyImportKind, rows: Record<string, unknown>[], extra = {}) {
  const fields = PHARMACY_IMPORT_FIELDS[kind].filter(field => Object.hasOwn(rows[0], field));
  const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return { locationId: f.locationId, kind, csv: [fields.map(cell).join(","), ...rows.map(row => fields.map(field => cell(row[field])).join(","))].join("\r\n"),
    mapping: Object.fromEntries(fields.map(field => [field, field])), sourceReference: "Actual opening export 2026-10-01", reviewReference: "Synthetic reviewed operator export", ...extra };
}
const catalogue = (sourceId = "001", barcode = "0000123") => ({ sourceId, name: 'Sample, "quoted" product', genericName: "Recorded formulation", category: "tablet", scheduleType: "general", baseUnit: "tablet", packUnit: "strip", unitsPerPack: "10", sellingPrice: "0.29", barcode });
const stock = (f: Fixture, sourceId = "lot-1", batchNumber = "PRINTED-1", looseUnits = "0") => ({ sourceId, medicineId: f.empty.id, baseUnit: "tablet", packUnit: "strip", unitsPerPack: "10", packs: "1", looseUnits, batchNumber, expiryPrecision: "month", expiry: "2099-12", purchaseTotal: "5.01", sellingPrice: "1.00", mrp: "1.20" });
async function preview(f: Fixture, kind: PharmacyImportKind, rows: Record<string, unknown>[], extra = {}) {
  const body = request(f, kind, rows, extra), response = await app.inject({ method: "POST", url: "/api/pharmacy/imports/preview", headers: f.headers, payload: body });
  expect(response.statusCode, response.body).toBe(200); return { body, view: response.json().data };
}
const commit = (f: Fixture, view: any, sourceKeys = view.units.filter((unit: any) => unit.status !== "invalid").map((unit: any) => unit.sourceKey)) => app.inject({ method: "POST", url: `/api/pharmacy/imports/${view.id}/commit`, headers: f.headers,
  payload: { locationId: f.locationId, expectedDigest: view.digest, confirmedSource: true, sourceKeys } });

describe("Reviewed source CSV import", () => {
  it("previews owned literal catalogue data without creating stock, products or liabilities, and encrypts its manifest", async () => {
    const f = await fixture(), before = await Medicine.countDocuments({ locationId: f.locationId }), { view } = await preview(f, "catalogue", [catalogue()]);
    expect(view.counts).toEqual({ posted: 0, invalid: 0, failed: 0, unprocessed: 1 });
    expect(view.rows[0].fields.barcode).toBe("0000123"); expect(await Medicine.countDocuments({ locationId: f.locationId })).toBe(before);
    const stored = await PharmacyImport.findById(view.id).select("+payloadCiphertext"); expect(stored!.payloadCiphertext).toMatch(/^enc:v1:/); expect(stored!.payloadCiphertext).not.toContain("Recorded formulation");
    expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
  });
  it("creates only an empty catalogue item once, retains leading zero barcode and requires separate classification/tax approval", async () => {
    const f = await fixture(), { view, body } = await preview(f, "catalogue", [catalogue()]);
    const first = await commit(f, view); expect(first.statusCode, first.body).toBe(200); const result = first.json().data.units[0].result;
    expect(result).toMatchObject({ stockQuantity: 0, classificationReviewRequired: true, taxReviewRequired: true });
    const product = await Medicine.findById(result.medicineId); expect(product!.barcodes).toEqual(["0000123"]); expect(product!.price).toBe(0.29); expect(product!.dispensingReview?.confirmedAt).toBeFalsy();
    expect((await commit(f, view)).json().data.counts.posted).toBe(1);
    const alternate = await app.inject({ method: "POST", url: "/api/pharmacy/imports/preview", headers: f.headers, payload: { ...body, csv: body.csv + "\r\n", reviewReference: "Explicit second source review" } });
    expect(alternate.statusCode, alternate.body).toBe(200); expect(alternate.json().data.units[0].status).toBe("posted");
    expect(await Medicine.countDocuments({ locationId: f.locationId, barcodes: "0000123" })).toBe(1);
  });
  it("binds identical file bytes to the original actual source reference across later mapping reviews", async () => {
    const f = await fixture(), { body } = await preview(f, "catalogue", [catalogue("original", "")]);
    const changed = await app.inject({ method: "POST", url: "/api/pharmacy/imports/preview", headers: f.headers, payload: { ...body, sourceReference: "Accidental renamed source", reviewReference: "Second operator review" } });
    expect(changed.statusCode, changed.body).toBe(409);
    expect(await PharmacyImport.countDocuments({ organizationId: f.organizationId })).toBe(1);
  });
  it("marks duplicate or already-assigned aliases and nonempty opening products during preview", async () => {
    const f = await fixture(), duplicates = await preview(f, "catalogue", [catalogue("one", "same-code"), catalogue("two", "same-code")]);
    expect(duplicates.view.totals.validRows).toBe(0);
    const known = await preview(f, "opening_stock", [{ ...stock(f), medicineId: f.medicine.id }]);
    expect(known.view.units[0].status).toBe("invalid"); expect(known.view.rows[0].error).toMatch(/no prior stock/);
  });
  it("bounds a complete 200-row review, keeps unrelated-unit totals separate and rejects a 201st record", async () => {
    const f = await fixture(), records = Array.from({ length: 200 }, (_, index) => catalogue(`source-${index}`, `000-code-${index}`));
    const start = performance.now(), { view } = await preview(f, "catalogue", records), elapsed = performance.now() - start;
    expect(view.rows).toHaveLength(200); expect(view.units).toHaveLength(200); expect(view.counts.unprocessed).toBe(200);
    expect(view.totals).toMatchObject({ validRows: 200, acquisitionPaise: 0, duesPaise: 0, baseQuantities: [] });
    const explained = await PharmacyImport.collection.find({ organizationId: new mongoose.Types.ObjectId(f.organizationId), locationId: new mongoose.Types.ObjectId(f.locationId), kind: "catalogue", fileHash: view.fileHash }).limit(1).explain("executionStats");
    expect(explained.executionStats.totalDocsExamined).toBeLessThanOrEqual(1); expect(JSON.stringify(explained.queryPlanner.winningPlan)).toContain("IXSCAN");
    console.info("T24 bounded synthetic review", JSON.stringify({ rows: 200, milliseconds: Math.round(elapsed), responseBytes: Buffer.byteLength(JSON.stringify(view)), sourceLookupDocuments: explained.executionStats.totalDocsExamined }));
    const tooMany = await app.inject({ method: "POST", url: "/api/pharmacy/imports/preview", headers: f.headers, payload: request(f, "catalogue", [...records, catalogue("last", "000-last")]) });
    expect(tooMany.statusCode).toBe(400);
  });
  it("imports multiple actual opening lots atomically for one empty product and reconciles exact source totals", async () => {
    const f = await fixture(), { view } = await preview(f, "opening_stock", [stock(f), stock(f, "lot-2", "PRINTED-2", "2")]);
    expect(view.units).toHaveLength(1); expect(view.totals).toMatchObject({ acquisitionPaise: 1002, baseQuantities: [{ baseUnit: "tablet", quantity: 22 }] });
    const posted = await commit(f, view); expect(posted.statusCode, posted.body).toBe(200); expect(posted.json().data.units[0].status).toBe("posted");
    expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(22);
    expect(await MedicineBatch.countDocuments({ medicineId: f.empty.id, receiptKind: "opening" })).toBe(2);
    expect(await StockMovement.countDocuments({ medicineId: f.empty.id, kind: "opening_receipt" })).toBe(2);
    expect((await commit(f, view)).json().data.counts.posted).toBe(1); expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(22);
  });
  it("serializes concurrent chunks into one source receipt without duplicate stock", async () => {
    const f = await fixture(), { view } = await preview(f, "opening_stock", [stock(f)]);
    const outcomes = await Promise.all([commit(f, view), commit(f, view)]);
    expect(outcomes.every(outcome => outcome.statusCode === 200)).toBe(true);
    expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(10); expect(await MedicineBatch.countDocuments({ medicineId: f.empty.id })).toBe(1);
  });
  it("rejects changed source facts and appending another lot to an already-posted opening group", async () => {
    const f = await fixture(), initial = await preview(f, "opening_stock", [stock(f)]); await commit(f, initial.view);
    const changed = await preview(f, "opening_stock", [stock(f), stock(f, "lot-2", "SECOND")]);
    expect(changed.view.units[0].status).toBe("conflict");
    const attempted = await commit(f, changed.view); expect(attempted.statusCode).toBe(409);
    expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(10);
  });
  it("keeps an entire product opening invalid when one lot has imprecise cost or mismatched units", async () => {
    const f = await fixture(), { view } = await preview(f, "opening_stock", [stock(f), { ...stock(f, "bad-lot"), purchaseTotal: "1.001" }]);
    expect(view.units[0].status).toBe("invalid"); expect(view.totals.validRows).toBe(0);
    const rejected = await commit(f, view, [view.units[0].sourceKey]); expect(rejected.statusCode).toBe(409); expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(0);
    const mismatch = await preview(f, "opening_stock", [{ ...stock(f), unitsPerPack: "20" }]); expect(mismatch.view.units[0].status).toBe("invalid");
  });
  it("rolls back every opening lot, its revision and source receipt when audit fails", async () => {
    const f = await fixture(), { view } = await preview(f, "opening_stock", [stock(f), stock(f, "lot-2", "SECOND")]);
    vi.spyOn(AuditLog, "create").mockRejectedValueOnce(new Error("Synthetic audit unavailable"));
    const response = await commit(f, view); expect(response.statusCode, response.body).toBe(200); expect(response.json().data.counts.failed).toBe(1);
    expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(0); expect(await MedicineBatch.countDocuments({ medicineId: f.empty.id })).toBe(0);
    expect(await OperationReceipt.countDocuments({ key: view.units[0].sourceKey })).toBe(0);
  });
  it.each(["customer_dues", "supplier_dues"] as const)("posts reviewed %s through the existing opening source without stock, turnover or tax", async kind => {
    const f = await fixture(), partyKind = kind === "customer_dues" ? "customer" : "supplier";
    const party = await PharmacyParty.create({ organizationId: f.organizationId, locationIds: [f.locationId], name: "Reviewed source party", normalizedName: "reviewed source party", address: "Actual address", kinds: [partyKind], gstRegistration: "unregistered", createdBy: f.user.id, updatedBy: f.user.id });
    const { view } = await preview(f, kind, [{ sourceId: "ACTUAL-001", partyId: party.id, sourceDate: "2026-10-01", amount: "499.01" }]);
    expect(view.totals.duesPaise).toBe(49901);
    const response = await commit(f, view); expect(response.statusCode, response.body).toBe(200); expect(response.json().data.counts.posted).toBe(1);
    expect(await PharmacyOpeningBalance.countDocuments({ organizationId: f.organizationId })).toBe(1);
    if (partyKind === "customer") expect(await Invoice.findOne({ organizationId: f.organizationId })).toMatchObject({ documentVersion: 3, totalAmount: 499.01, tax: 0, items: [] });
    else expect(await Invoice.countDocuments({ organizationId: f.organizationId })).toBe(0);
    expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(0);
    expect((await commit(f, view)).json().data.counts.posted).toBe(1);
  });
  it("retains explicit failed, posted and unprocessed states across bounded interrupted chunks", async () => {
    const f = await fixture(), { view } = await preview(f, "catalogue", [catalogue("1", "00001"), catalogue("2", "00002"), catalogue("3", "00003")]);
    await Medicine.create({ locationId: f.locationId, name: "Concurrent alias", genericName: "Synthetic", price: 1, barcodes: ["00001"] });
    const response = await commit(f, view, view.units.slice(0, 2).map((unit: any) => unit.sourceKey));
    expect(response.statusCode, response.body).toBe(200); expect(response.json().data.counts).toEqual({ posted: 1, failed: 1, invalid: 0, unprocessed: 1 });
    const resumed = await commit(f, view, [view.units[2].sourceKey]); expect(resumed.json().data.counts).toEqual({ posted: 2, failed: 1, invalid: 0, unprocessed: 0 });
    const exported = await app.inject({ method: "GET", url: `/api/pharmacy/imports/${view.id}/export?locationId=${f.locationId}`, headers: f.headers });
    expect(exported.statusCode).toBe(200); expect(exported.body).toContain("posted"); expect(exported.body).toContain("failed");
  });
  it("denies foreign manifest IDs and revocation of cost authority before any opening post/read/export", async () => {
    const f = await fixture(), foreign = await fixture(), { view } = await preview(f, "opening_stock", [stock(f)]);
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/imports/${view.id}?locationId=${foreign.locationId}`, headers: foreign.headers })).statusCode).toBe(404);
    await Role.updateOne({ name: f.role, organizationId: f.organizationId }, { permissions: ["PHARMACY_RECEIVE_STOCK", "PHARMACY_VIEW_STOCK"] });
    expect((await commit(f, view)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/api/pharmacy/imports/${view.id}/export?locationId=${f.locationId}`, headers: f.headers })).statusCode).toBe(403);
    expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(0);
  });
  it("requires exact manifest confirmation and refuses more than ten source units per chunk", async () => {
    const f = await fixture(), { view } = await preview(f, "catalogue", Array.from({ length: 11 }, (_, index) => catalogue(`source-${index}`, `barcode-${index}`)));
    expect((await commit(f, view)).statusCode).toBe(400);
    const response = await app.inject({ method: "POST", url: `/api/pharmacy/imports/${view.id}/commit`, headers: f.headers, payload: { locationId: f.locationId, expectedDigest: "a".repeat(64), confirmedSource: true, sourceKeys: [view.units[0].sourceKey] } });
    expect(response.statusCode).toBe(409);
  });
  it("marks duplicate normalized source IDs invalid and neutralizes literal spreadsheet formulas in reconciliation", async () => {
    const f = await fixture(), duplicate = await preview(f, "catalogue", [catalogue("Ａ", "00001"), catalogue("A", "00002")]);
    expect(duplicate.view.counts.invalid).toBeGreaterThan(0); expect(duplicate.view.totals.validRows).toBe(0);
    const formula = await preview(f, "catalogue", [{ ...catalogue("=1+2"), name: "=1+2" }]);
    const exported = await app.inject({ method: "GET", url: `/api/pharmacy/imports/${formula.view.id}/export?locationId=${f.locationId}`, headers: f.headers });
    expect(exported.statusCode).toBe(200); expect(exported.body).toContain("'=1+2");
  });
  it("holds a mismatched committed result for review rather than showing a false posted source", async () => {
    const f = await fixture(), { view } = await preview(f, "catalogue", [catalogue()]); await commit(f, view);
    await OperationReceipt.updateOne({ key: view.units[0].sourceKey, scope: `pharmacy-import-source:${f.organizationId}:${f.locationId}:catalogue` }, { responseCiphertext: JSON.stringify({ version: 1, data: { medicineId: new mongoose.Types.ObjectId().toString() } }) });
    const source = await app.inject({ method: "GET", url: `/api/pharmacy/imports/${view.id}?locationId=${f.locationId}`, headers: f.headers });
    expect(source.statusCode, source.body).toBe(200); expect(source.json().data.units[0].status).toBe("unknown"); expect(source.json().data.counts.posted).toBe(0);
  });
  it("does not interpret INR source amounts in another organization currency at preview or posting", async () => {
    const f = await fixture(); await Organization.updateOne({ _id: f.organizationId }, { currency: "USD" });
    const denied = await app.inject({ method: "POST", url: "/api/pharmacy/imports/preview", headers: f.headers, payload: request(f, "catalogue", [catalogue()]) });
    expect(denied.statusCode, denied.body).toBe(409);
    await Organization.updateOne({ _id: f.organizationId }, { currency: "INR" });
    const { view } = await preview(f, "opening_stock", [stock(f)]);
    await Organization.updateOne({ _id: f.organizationId }, { currency: "USD" });
    const changed = await commit(f, view); expect(changed.statusCode, changed.body).toBe(200); expect(changed.json().data.counts.failed).toBe(1);
    expect((await Medicine.findById(f.empty.id))!.stockQuantity).toBe(0);
  });
});

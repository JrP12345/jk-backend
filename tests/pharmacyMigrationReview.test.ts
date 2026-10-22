import mongoose, { mongo } from "mongoose";
import { beforeAll, describe, expect, it } from "vitest";
import { reviewPharmacyMigrationPage, type PharmacyReviewInput } from "../services/PharmacyMigrationReviewService.ts";
import { parsePharmacyReviewArguments } from "../scripts/review-pharmacy-migration.ts";

const db = () => mongoose.connection.db!;
const oid = () => new mongo.ObjectId();
beforeAll(async () => {
  // The application's test setup registers models. Finish those background index builds
  // before exercising the review's snapshot transactions; the CLI registers none.
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
});
async function fixture() {
  const organizationId = oid(), locationId = oid();
  await db().collection("organizations").insertOne({ _id: organizationId, name: "Synthetic review owner" });
  await db().collection("locations").insertOne({ _id: locationId, organizationId, isActive: true });
  const input: PharmacyReviewInput = { organizationId: String(organizationId), locationId: String(locationId), section: "inventory", snapshotId: "synthetic-frozen-1", asOf: "2026-10-20T00:00:00.000Z", limit: 2 };
  const medicine = async (fields: Record<string, unknown> = {}) => {
    const row = { _id: oid(), locationId, stockQuantity: 0, stockRevision: 0, price: 10, genericName: "Synthetic composition", name: "Synthetic review medicine", updatedAt: new Date("2026-10-19T00:00:00Z"), ...fields };
    await db().collection("medicines").insertOne(row); return row;
  };
  const batch = async (medicineId: mongo.ObjectId, fields: Record<string, unknown> = {}) => {
    const row = { _id: oid(), organizationId, locationId, medicineId, batchNumber: "SYNTHETIC", quantity: 4, status: "active", expiryDate: new Date("2027-01-01"), purchaseCost: 2, sellingPrice: 10, ...fields };
    await db().collection("medicinebatches").insertOne(row); return row;
  };
  return { organizationId, locationId, input, medicine, batch };
}
const unit = { version: 1, baseUnit: "tablet", packUnit: "strip", unitsPerPack: 10 };

describe("Read-only pharmacy migration review", () => {
  it("is deterministic, contains no patient details and emits no database write or index command", async () => {
    const f = await fixture(), row = await f.medicine({ stockQuantity: 4, unitDefinition: unit });
    await f.batch(row._id);
    const connection = await mongoose.createConnection(process.env.MONGODB_URI!, { autoIndex: false, autoCreate: false, monitorCommands: true }).asPromise();
    const client = connection.getClient(), commands: string[] = [];
    const listener = (event: mongo.CommandStartedEvent) => commands.push(event.commandName);
    client.on("commandStarted", listener);
    let first;
    try {
      first = await reviewPharmacyMigrationPage(f.input, connection);
      expect(await reviewPharmacyMigrationPage(f.input, connection)).toEqual(first);
    } finally { client.off("commandStarted", listener); await connection.close(); }
    expect(commands).toContain("find"); expect(commands).toContain("abortTransaction");
    expect(commands.filter(command => /^(insert|update|delete|findAndModify|create|createIndexes|drop|dropIndexes|commitTransaction|aggregate)$/i.test(command))).toEqual([]);
    expect(first).toMatchObject({ readOnly: true, applySupported: false, rolloutApproved: false, readIsolation: "snapshot_per_page", nextCursor: null });
    expect(first!.records[0]).toMatchObject({ medicineId: String(row._id), aggregateQuantity: 4, batchQuantity: 4, eligibleQuantity: 4, proposedOpeningQuantity: null, action: "review_only" });
    expect(JSON.stringify(first)).not.toContain("Synthetic composition");
    expect((await db().collection("medicines").findOne({ _id: row._id }))!.stockQuantity).toBe(4);
  });
  it("paginates all rows including deleted products without treating one page as rollout approval", async () => {
    const f = await fixture();
    const rows = [await f.medicine(), await f.medicine({ deletedAt: new Date(), stockQuantity: 3 }), await f.medicine()];
    const first = await reviewPharmacyMigrationPage(f.input);
    expect(first.records).toHaveLength(2); expect(first.pageComplete).toBe(false); expect(first.nextCursor).toBe(String(rows[1]._id));
    const second = await reviewPharmacyMigrationPage({ ...f.input, cursor: first.nextCursor! });
    expect(second.records.map(row => row.medicineId)).toEqual([String(rows[2]._id)]); expect(second.pageComplete).toBe(true);
    expect(first.issues.deleted_with_stock).toBe(1); expect(second.rolloutApproved).toBe(false);
  });
  it("rejects forged tenant scope and does not include records from another branch", async () => {
    const f = await fixture(), other = await fixture();
    await f.medicine(); await other.medicine({ name: "Foreign private marker" });
    await expect(reviewPharmacyMigrationPage({ ...f.input, locationId: other.input.locationId })).rejects.toThrow("does not belong");
    const report = await reviewPharmacyMigrationPage(f.input); expect(report.records).toHaveLength(1); expect(JSON.stringify(report)).not.toContain("Foreign private marker");
    expect(await reviewPharmacyMigrationPage({ ...f.input, organizationId: f.input.organizationId.toUpperCase(), locationId: f.input.locationId.toUpperCase() })).toEqual(report);
  });
  it.each([{ organizationId: "bad" }, { cursor: "bad" }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { asOf: "2026-10-20" }, { snapshotId: "../secret" }])("rejects invalid review inputs %j", async fields => {
    const f = await fixture(); await expect(reviewPharmacyMigrationPage({ ...f.input, ...fields })).rejects.toThrow();
  });
  it("reports aggregate/batch discrepancies and expired quantities without inventing opening stock", async () => {
    const f = await fixture(), row = await f.medicine({ stockQuantity: 10 });
    await f.batch(row._id, { quantity: 3, expiryDate: new Date("2026-01-01") });
    const report = await reviewPharmacyMigrationPage(f.input);
    expect(report.records[0]).toMatchObject({ aggregateQuantity: 10, batchQuantity: 3, eligibleQuantity: 0, expiredQuantity: 3, proposedOpeningQuantity: null });
    expect(report.records[0].issues).toEqual(expect.arrayContaining(["aggregate_batch_difference", "no_eligible_lot", "unit_basis_review", "legacy_lot_snapshot_review"]));
    expect(await db().collection("stockmovements").countDocuments({ medicineId: row._id })).toBe(0);
  });
  it("finds mixed-location history, missing organizations, duplicate batch labels and orphan batches", async () => {
    const f = await fixture(), other = await fixture(), row = await f.medicine({ stockQuantity: 8 });
    await f.batch(row._id, { locationId: other.locationId, organizationId: other.organizationId });
    await f.batch(row._id, { organizationId: null });
    const orphan = await f.batch(oid());
    const inventory = await reviewPharmacyMigrationPage(f.input);
    expect(inventory.records[0].issues).toEqual(expect.arrayContaining(["lot_location_conflict", "organization_conflict", "lot_organization_missing", "duplicate_batch_label"]));
    const batches = await reviewPharmacyMigrationPage({ ...f.input, section: "batches", limit: 100 });
    expect(batches.records.find(row => row.batchId === String(orphan._id))!.issues).toContain("missing_scoped_medicine");
  });
  it("does not manufacture safe totals from malformed stock, expiry, prices or ledger checkpoints", async () => {
    const f = await fixture(), row = await f.medicine({ stockQuantity: "4", unitDefinition: { ...unit, unitsPerPack: 0 }, stockLedgerStartedAt: new Date() });
    await f.batch(row._id, { quantity: -1, status: "depleted", expiryDate: "not a date", purchaseCost: null });
    await db().collection("stockmovements").insertOne({ medicineId: row._id, revision: 8, afterQuantity: 4, locationId: f.locationId, organizationId: f.organizationId });
    const report = await reviewPharmacyMigrationPage(f.input);
    expect(report.records[0]).toMatchObject({ aggregateQuantity: null, batchQuantity: null, eligibleQuantity: null, expiredQuantity: null });
    expect(report.records[0].issues).toEqual(expect.arrayContaining(["invalid_aggregate", "invalid_lot_quantity", "lot_expiry_unknown", "lot_price_review", "lot_status_conflict", "ledger_checkpoint_conflict", "unit_basis_review"]));
  });
  it("recognizes separately captured cost lots sharing a printed batch without calling them legacy duplicates", async () => {
    const f = await fixture(), row = await f.medicine({ stockQuantity: 8, unitDefinition: unit });
    const expiryDate = new Date("2027-01-01"), snapshot = { lotVersion: 1, receiptKind: "receipt", receivedAt: new Date("2026-10-19"), receivedQuantity: 4,
      unitSnapshot: unit, costBasis: { totalPaise: 800, receivedBaseUnits: 4, currency: "INR" }, sellingPricePaise: 1000,
      expirySnapshot: { precision: "day", value: "2026-12-31", timezone: "UTC", cutoff: expiryDate }, expiryDate };
    await f.batch(row._id, { ...snapshot, receiptLineId: "source-line-0001" });
    await f.batch(row._id, { ...snapshot, receiptLineId: "source-line-0002" });
    const report = await reviewPharmacyMigrationPage(f.input);
    expect(report.issues).not.toHaveProperty("duplicate_batch_label"); expect(report.issues).not.toHaveProperty("legacy_lot_snapshot_review");
    expect(report.issues).not.toHaveProperty("captured_lot_evidence_review");
  });
  it("stops partial related-row sums and changes its fingerprint after source drift", async () => {
    const f = await fixture(), row = await f.medicine();
    await db().collection("medicinebatches").insertMany(Array.from({ length: 501 }, (_, index) => ({ _id: oid(), medicineId: row._id, locationId: f.locationId, organizationId: f.organizationId, batchNumber: `B${index}`, quantity: 0, status: "depleted", expiryDate: new Date("2027-01-01"), purchaseCost: 2, sellingPrice: 3 })));
    const first = await reviewPharmacyMigrationPage(f.input);
    expect(first.records[0]).toMatchObject({ relatedRowsComplete: false, batchQuantity: null, eligibleQuantity: null });
    expect(first.issues.related_rows_exceed_limit).toBe(1);
    await db().collection("medicines").updateOne({ _id: row._id }, { $set: { stockQuantity: 1 } });
    const second = await reviewPharmacyMigrationPage(f.input);
    expect(second.sourceFingerprint).not.toBe(first.sourceFingerprint); expect(second.manifestFingerprint).not.toBe(first.manifestFingerprint);
  });
  it("rejects an unsafe batch sum and never converts aggregate-only expired stock to saleable stock", async () => {
    const f = await fixture(), row = await f.medicine({ stockQuantity: Number.MAX_SAFE_INTEGER });
    await f.batch(row._id, { quantity: Number.MAX_SAFE_INTEGER }); await f.batch(row._id, { batchNumber: "OVERFLOW", quantity: 1 });
    const legacy = await f.medicine({ stockQuantity: 9, expiryDate: new Date("2026-01-01") });
    const report = await reviewPharmacyMigrationPage(f.input);
    expect(report.issues.quantity_sum_overflow).toBe(1);
    expect(report.records[0]).toMatchObject({ batchQuantity: null, eligibleQuantity: null, proposedOpeningQuantity: null });
    expect(report.records.find(item => item.medicineId === String(legacy._id))!.issues).toContain("legacy_expiry_unavailable");
  });
  it("preserves legacy invoices and reports broken source references without printing patient or invoice details", async () => {
    const f = await fixture(), invoiceId = oid(), dispenseId = oid(), lineId = oid();
    await db().collection("invoices").insertMany([
      { _id: invoiceId, locationId: f.locationId, organizationId: f.organizationId, documentVersion: 1, numberingVersion: 2, issuedAt: new Date(), patientId: oid(), invoiceNumber: "PRIVATE-NUMBER", notes: "PRIVATE-CLINICAL-NOTES", items: [{ pharmacyDispenseId: dispenseId, pharmacyDispenseLineId: lineId, quantity: 2, amount: 5, totalItemAmount: 10 }] },
      { _id: oid(), locationId: f.locationId, invoiceNumber: "LEGACY", items: [] },
    ]);
    const before = await db().collection("invoices").find({ locationId: f.locationId }).sort({ _id: 1 }).toArray();
    const report = await reviewPharmacyMigrationPage({ ...f.input, section: "invoices" });
    expect(report.issues.invoice_source_conflict).toBe(1); expect(report.issues.legacy_invoice_provenance_review).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE-NUMBER|PRIVATE-CLINICAL-NOTES|patientId/);
    expect(await db().collection("invoices").find({ locationId: f.locationId }).sort({ _id: 1 }).toArray()).toEqual(before);
  });
  it("recognizes matching source quantities and reports legacy register gaps without creating evidence", async () => {
    const f = await fixture(), invoiceId = oid(), dispenseId = oid(), lineId = oid();
    await db().collection("pharmacydispenses").insertOne({ _id: dispenseId, organizationId: f.organizationId, locationId: f.locationId, invoiceId, lines: [{ _id: lineId, quantity: 2, amount: 5, lineAmount: 10 }] });
    await db().collection("invoices").insertOne({ _id: invoiceId, organizationId: f.organizationId, locationId: f.locationId, documentVersion: 1, numberingVersion: 2, issuedAt: new Date(), items: [{ pharmacyDispenseId: dispenseId, pharmacyDispenseLineId: lineId, quantity: 2, amount: 5, totalItemAmount: 10 }] });
    expect((await reviewPharmacyMigrationPage({ ...f.input, section: "invoices" })).issues).toEqual({});
    const register = { _id: oid(), locationId: f.locationId, organizationId: f.organizationId, patientName: "PRIVATE-NAME", doctorName: "PRIVATE-DOCTOR", dispenseId: oid() };
    await db().collection("scheduleh1registers").insertOne(register);
    const report = await reviewPharmacyMigrationPage({ ...f.input, section: "register" });
    expect(report.issues).toMatchObject({ register_historical_evidence_review: 1, register_source_conflict: 1 });
    expect(JSON.stringify(report)).not.toMatch(/PRIVATE-NAME|PRIVATE-DOCTOR/);
    expect(await db().collection("scheduleh1registers").findOne({ _id: register._id })).toEqual(register);
  });
  it("audits legacy grants and duplicate subscriptions without granting paid access", async () => {
    const f = await fixture(), other = await fixture();
    await db().collection("subscriptions").insertMany([{ organizationId: f.organizationId }, { organizationId: f.organizationId, entitlementSource: "manual" }]);
    await db().collection("orgmembers").insertMany([{ userId: oid(), organizationId: f.organizationId }, { userId: oid(), organizationId: f.organizationId, locationAccess: { mode: "selected", locationIds: [other.locationId] } }]);
    const report = await reviewPharmacyMigrationPage({ ...f.input, section: "access" });
    expect(report.issues).toMatchObject({ subscription_cardinality_review: 1, legacy_entitlement_mapping_review: 1, manual_grant_evidence_review: 1,
      implicit_or_duplicate_module_review: 1, legacy_capability_mapping_review: 1, legacy_branch_grant_review: 1, branch_grant_reference_review: 1 });
    expect(report.records[0].action).toBe("no_grant_activation");
    expect(await db().collection("subscriptions").countDocuments({ organizationId: f.organizationId })).toBe(2);
  });
  it("lists existing index definitions without replacing the legacy batch-label constraint", async () => {
    const f = await fixture(), row = await f.medicine(); await f.batch(row._id);
    await db().collection("medicinebatches").createIndex({ medicineId: 1, locationId: 1, batchNumber: 1 }, { name: "synthetic_legacy_label", unique: true, partialFilterExpression: { locationId: f.locationId } });
    const report = await reviewPharmacyMigrationPage({ ...f.input, section: "indexes" });
    expect(report.readIsolation).toBe("metadata_read");
    expect(report.records.find(row => row.collection === "medicinebatches")!.indexes).toEqual(expect.arrayContaining([expect.objectContaining({ name: "synthetic_legacy_label", unique: true })]));
    expect((await db().collection("medicinebatches").listIndexes().toArray()).some(index => index.name === "synthetic_legacy_label")).toBe(true);
  });
  it("includes inactive owned locations in review without enabling their capability", async () => {
    const f = await fixture();
    await db().collection("locations").updateOne({ _id: f.locationId }, { $set: { isActive: false, pharmacyCapability: { enabled: false, revision: 2 } } });
    await f.medicine();
    expect((await reviewPharmacyMigrationPage(f.input)).records).toHaveLength(1);
    expect((await db().collection("locations").findOne({ _id: f.locationId }))!.pharmacyCapability).toEqual({ enabled: false, revision: 2 });
  });
});

describe("Review CLI boundary", () => {
  const args = ["--organization", "000000000000000000000001", "--location", "000000000000000000000002", "--snapshot-id", "review-1", "--as-of", "2026-10-20T00:00:00.000Z", "--section", "inventory"];
  it("requires explicit scope and has no apply, write-pause or application-connection option", () => {
    expect(parsePharmacyReviewArguments(args)).toMatchObject({ section: "inventory", snapshotId: "review-1" });
    for (const extra of [["--apply", "true"], ["--writes-paused", "true"], ["--uri", "secret"], ["--organization", "duplicate"], ["--limit"]]) expect(() => parsePharmacyReviewArguments([...args, ...extra])).toThrow();
    expect(() => parsePharmacyReviewArguments([])).toThrow();
    expect(() => parsePharmacyReviewArguments([...args, "--limit", "0"])).toThrow();
    expect(() => parsePharmacyReviewArguments(args.map(value => value === "000000000000000000000001" ? "invalid" : value))).toThrow();
  });
});

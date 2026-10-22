import mongoose, { mongo } from "mongoose";
import crypto from "node:crypto";

export const PHARMACY_REVIEW_SECTIONS = ["inventory", "batches", "invoices", "register", "access", "indexes"] as const;
export type PharmacyReviewSection = typeof PHARMACY_REVIEW_SECTIONS[number];
export interface PharmacyReviewInput {
  organizationId: string; locationId: string; snapshotId: string; asOf: string;
  section: PharmacyReviewSection; cursor?: string; limit?: number;
}
const MAX_RELATED = 500;
const id = (value: unknown) => value == null ? null : String(value);
const safeQuantity = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const hash = (value: unknown): string => {
  const canonical = (item: any): any => item instanceof Date ? item.toISOString() : item instanceof mongo.ObjectId ? item.toHexString()
    : Array.isArray(item) ? item.map(canonical) : item && typeof item === "object" ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
  return crypto.createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
};
export function validatePharmacyReviewInput(input: PharmacyReviewInput) {
  if (![input.organizationId, input.locationId, ...(input.cursor ? [input.cursor] : [])].every(value => /^[a-f\d]{24}$/i.test(value))) throw new Error("Explicit organization, location and valid cursor IDs are required");
  if (!PHARMACY_REVIEW_SECTIONS.includes(input.section) || !/^[A-Za-z0-9._-]{1,100}$/.test(input.snapshotId)) throw new Error("A review section and snapshot label are required");
  if (!Number.isFinite(Date.parse(input.asOf)) || new Date(input.asOf).toISOString() !== input.asOf) throw new Error("Use a canonical ISO as-of timestamp");
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || input.section === "indexes" && input.cursor) throw new Error("Page size must be 1..100; index metadata has no cursor");
  return { limit, organizationId: new mongo.ObjectId(input.organizationId), locationId: new mongo.ObjectId(input.locationId) };
}

/** Native, projection-only reads: no model registration, auto-indexing, entitlement activation or backfill. */
export async function reviewPharmacyMigrationPage(input: PharmacyReviewInput, connection = mongoose.connection) {
  const scope = validatePharmacyReviewInput(input), db = connection.db;
  input = { ...input, organizationId: scope.organizationId.toHexString(), locationId: scope.locationId.toHexString(), ...(input.cursor ? { cursor: input.cursor.toLowerCase() } : {}) };
  if (!db) throw new Error("A reviewed snapshot connection is required");
  const session = await connection.startSession();
  try {
    // Index metadata cannot be listed in a MongoDB transaction. All data sections use one snapshot per page.
    if (input.section !== "indexes") session.startTransaction({ readConcern: { level: "snapshot" }, readPreference: "primary" });
    const sessionOptions = input.section === "indexes" ? {} : { session };
    const find = (collection: string, filter: mongo.Filter<mongo.Document>, projection: mongo.Document, limit: number, sort: mongo.Sort = { _id: 1 }) =>
      db.collection(collection).find(filter, { ...sessionOptions, projection, maxTimeMS: 8000 }).sort(sort).limit(limit).toArray();
    const organization = (await find("organizations", { _id: scope.organizationId }, { _id: 1, plan: 1, limits: 1 }, 1))[0];
    const location = (await find("locations", { _id: scope.locationId, organizationId: scope.organizationId }, { _id: 1, organizationId: 1, isActive: 1, pharmacyCapability: 1 }, 1))[0];
    if (!organization || !location) throw new Error("Reviewed location does not belong to the selected organization");
    const after = input.cursor ? { _id: { $gt: new mongo.ObjectId(input.cursor) } } : {};
    const issues: Record<string, number> = {};
    const evidence: unknown[] = [organization, location];
    const add = (codes: string[], code: string) => { if (!codes.includes(code)) { codes.push(code); issues[code] = (issues[code] ?? 0) + 1; } };
    const records: Array<Record<string, unknown>> = [];
    let nextCursor: string | null = null;
    const page = async (collection: string, filter: mongo.Filter<mongo.Document>, projection: mongo.Document) => {
      const rows = await find(collection, { ...filter, ...after }, projection, scope.limit + 1);
      const selected = rows.slice(0, scope.limit); evidence.push(selected);
      nextCursor = rows.length > scope.limit ? id(selected.at(-1)!._id) : null;
      return selected;
    };
    if (input.section === "inventory") {
      const medicines = await page("medicines", { locationId: scope.locationId }, { locationId: 1, organizationId: 1, stockQuantity: 1, stockRevision: 1, stockLedgerStartedAt: 1, unitDefinition: 1,
        batchNumber: 1, expiryDate: 1, barcodes: 1, deletedAt: 1, updatedAt: 1 });
      for (const medicine of medicines) {
        const codes: string[] = [];
        const lots = await find("medicinebatches", { medicineId: medicine._id }, { locationId: 1, organizationId: 1, batchNumber: 1, quantity: 1, status: 1, expiryDate: 1, purchaseCost: 1, sellingPrice: 1, mrp: 1, updatedAt: 1,
          lotVersion: 1, receiptLineId: 1, receiptKind: 1, receivedAt: 1, receivedQuantity: 1, unitSnapshot: 1, costBasis: 1, expirySnapshot: 1, sellingPricePaise: 1, mrpPaise: 1 }, MAX_RELATED + 1);
        const latest = (await find("stockmovements", { medicineId: medicine._id }, { revision: 1, afterQuantity: 1, organizationId: 1, locationId: 1 }, 1, { revision: -1, _id: -1 }))[0];
        evidence.push(lots, latest ?? null);
        if (medicine.organizationId && id(medicine.organizationId) !== input.organizationId) add(codes, "organization_conflict");
        if (!safeQuantity(medicine.stockQuantity) || !safeQuantity(medicine.stockRevision ?? 0)) add(codes, "invalid_aggregate");
        const unit = medicine.unitDefinition;
        if (!unit || !safeQuantity(unit.version) || unit.version < 1 || !["tablet", "capsule", "ml", "g", "piece", "dose"].includes(unit.baseUnit) ||
            !["strip", "box", "bottle", "vial", "tube", "ampoule", "sachet", "pack", "piece"].includes(unit.packUnit) || !safeQuantity(unit.unitsPerPack) || unit.unitsPerPack < 1 || unit.unitsPerPack > 1_000_000) add(codes, "unit_basis_review");
        if (!latest && medicine.stockLedgerStartedAt || latest && (!medicine.stockLedgerStartedAt || latest.revision !== (medicine.stockRevision ?? 0) || latest.afterQuantity !== medicine.stockQuantity ||
            id(latest.organizationId) !== input.organizationId || id(latest.locationId) !== input.locationId)) add(codes, "ledger_checkpoint_conflict");
        if (!latest) add(codes, "prospective_ledger_only");
        let total: number | null = 0, eligible: number | null = 0, expired: number | null = 0;
        if (lots.length > MAX_RELATED) { add(codes, "related_rows_exceed_limit"); total = eligible = expired = null; }
        const labels = new Map<string, mongo.Document>();
        for (const lot of lots.slice(0, MAX_RELATED)) {
          if (!lot.organizationId) add(codes, "lot_organization_missing");
          else if (id(lot.organizationId) !== input.organizationId) add(codes, "organization_conflict");
          if (id(lot.locationId) !== input.locationId) add(codes, "lot_location_conflict");
          const sameLabel = labels.get(lot.batchNumber);
          if (sameLabel && (lot.lotVersion !== 1 || sameLabel.lotVersion !== 1 || lot.receiptLineId === sameLabel.receiptLineId)) add(codes, "duplicate_batch_label");
          labels.set(lot.batchNumber, lot);
          if (!safeQuantity(lot.quantity)) { add(codes, "invalid_lot_quantity"); total = eligible = expired = null; }
          else if (total !== null) {
            total += lot.quantity;
            if (!Number.isSafeInteger(total)) { add(codes, "quantity_sum_overflow"); total = eligible = expired = null; }
            else if (date(lot.expiryDate)) {
              if (lot.expiryDate <= new Date(input.asOf)) expired! += lot.quantity;
              else if (lot.status === "active") eligible! += lot.quantity;
            }
          }
          if (!date(lot.expiryDate)) add(codes, "lot_expiry_unknown");
          if (!["active", "expired", "depleted"].includes(lot.status) || lot.status === "depleted" && lot.quantity !== 0) add(codes, "lot_status_conflict");
          if (![lot.purchaseCost, lot.sellingPrice].every(value => typeof value === "number" && Number.isFinite(value) && value >= 0) ||
              lot.mrp != null && (typeof lot.mrp !== "number" || !Number.isFinite(lot.mrp) || lot.mrp < 0)) add(codes, "lot_price_review");
          if (lot.lotVersion !== 1) add(codes, "legacy_lot_snapshot_review");
          else if (!unit || ["version", "baseUnit", "packUnit", "unitsPerPack"].some(key => lot.unitSnapshot?.[key] !== unit[key]) ||
              !date(lot.receivedAt) || !safeQuantity(lot.receivedQuantity) || lot.receivedQuantity < 1 || !safeQuantity(lot.costBasis?.totalPaise) ||
              lot.costBasis?.receivedBaseUnits !== lot.receivedQuantity || lot.costBasis?.currency !== "INR" ||
              lot.purchaseCost !== lot.costBasis.totalPaise / lot.receivedQuantity / 100 || !safeQuantity(lot.sellingPricePaise) || lot.sellingPrice !== lot.sellingPricePaise / 100 ||
              !date(lot.expirySnapshot?.cutoff) || date(lot.expirySnapshot.cutoff) !== date(lot.expiryDate) ||
              !["day", "month"].includes(lot.expirySnapshot.precision) || !/^[a-zA-Z0-9_-]{8,100}$/.test(lot.receiptLineId || "")) add(codes, "captured_lot_evidence_review");
        }
        if (lots.length && total !== null && total !== medicine.stockQuantity) add(codes, "aggregate_batch_difference");
        if (!lots.length && medicine.stockQuantity > 0) {
          add(codes, "legacy_opening_review");
          if (!date(medicine.expiryDate) || medicine.expiryDate <= new Date(input.asOf)) add(codes, "legacy_expiry_unavailable");
        }
        if (lots.length && safeQuantity(medicine.stockQuantity) && medicine.stockQuantity > 0 && eligible === 0) add(codes, "no_eligible_lot");
        if (medicine.deletedAt && medicine.stockQuantity > 0) add(codes, "deleted_with_stock");
        if (Array.isArray(medicine.barcodes)) for (const alias of [...new Set(medicine.barcodes)].slice(0, 20)) {
          if (typeof alias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(alias)) { add(codes, "barcode_review"); continue; }
          const matches = await find("medicines", { locationId: scope.locationId, deletedAt: null, barcodes: alias }, { _id: 1 }, 2);
          evidence.push(matches);
          if (matches.length > 1 && !medicine.deletedAt) add(codes, "duplicate_active_barcode");
        }
        if (medicine.barcodes != null && (!Array.isArray(medicine.barcodes) || medicine.barcodes.length > 20 || new Set(medicine.barcodes).size !== medicine.barcodes.length)) add(codes, "barcode_review");
        records.push({ medicineId: id(medicine._id), expectedUpdatedAt: date(medicine.updatedAt), expectedRevision: safeQuantity(medicine.stockRevision ?? 0) ? medicine.stockRevision ?? 0 : null,
          aggregateQuantity: safeQuantity(medicine.stockQuantity) ? medicine.stockQuantity : null,
          batchQuantity: lots.length ? total : null, eligibleQuantity: lots.length ? eligible : null, expiredQuantity: lots.length ? expired : null,
          relatedRowsComplete: lots.length <= MAX_RELATED, issues: codes.sort(), proposedOpeningQuantity: null, action: "review_only" });
      }
    } else if (input.section === "batches") {
      const rows = await page("medicinebatches", { locationId: scope.locationId }, { medicineId: 1, locationId: 1, organizationId: 1, quantity: 1, batchNumber: 1, updatedAt: 1 });
      for (const row of rows) {
        const codes: string[] = [];
        const medicine = (await find("medicines", { _id: row.medicineId, locationId: scope.locationId }, { _id: 1, organizationId: 1 }, 1))[0];
        evidence.push(medicine ?? null);
        if (!medicine) add(codes, "missing_scoped_medicine");
        if (!row.organizationId) add(codes, "lot_organization_missing");
        if (row.organizationId && id(row.organizationId) !== input.organizationId || medicine?.organizationId && id(medicine.organizationId) !== input.organizationId) add(codes, "organization_conflict");
        records.push({ batchId: id(row._id), expectedUpdatedAt: date(row.updatedAt), issues: codes.sort(), action: "review_only" });
      }
    } else if (input.section === "invoices") {
      // Inspect every branch invoice: legacy medicine descriptions are not a reliable complete selector.
      const rows = await page("invoices", { locationId: scope.locationId }, { organizationId: 1, locationId: 1, documentVersion: 1, numberingVersion: 1, issuedAt: 1, updatedAt: 1,
        invoiceNumber: 1, totalAmount: 1, amountPaid: 1, currency: 1, "items.pharmacyDispenseId": 1, "items.pharmacyDispenseLineId": 1, "items.amount": 1, "items.quantity": 1, "items.totalItemAmount": 1 });
      for (const row of rows) {
        const codes: string[] = [], items = Array.isArray(row.items) ? row.items : [], sourceLines = new Set<string>();
        if (!row.organizationId) add(codes, "invoice_organization_missing");
        else if (id(row.organizationId) !== input.organizationId) add(codes, "organization_conflict");
        if (!row.documentVersion) add(codes, "legacy_invoice_provenance_review");
        if (row.documentVersion && (row.documentVersion !== 1 || row.numberingVersion !== 2 || !date(row.issuedAt) || !items.length)) add(codes, "issued_document_evidence_review");
        if (items.length > MAX_RELATED) add(codes, "related_rows_exceed_limit");
        for (const item of items.slice(0, MAX_RELATED)) if (item.pharmacyDispenseId || item.pharmacyDispenseLineId) {
          const lineKey = id(item.pharmacyDispenseLineId);
          if (!lineKey || sourceLines.has(lineKey)) add(codes, "invoice_source_conflict");
          if (lineKey) sourceLines.add(lineKey);
          const source = (await find("pharmacydispenses", { _id: item.pharmacyDispenseId, organizationId: scope.organizationId, locationId: scope.locationId, invoiceId: row._id },
            { invoiceId: 1, "lines._id": 1, "lines.amount": 1, "lines.quantity": 1, "lines.lineAmount": 1 }, 1))[0];
          evidence.push(source ?? null);
          const line = Array.isArray(source?.lines) ? source.lines.find((candidate: mongo.Document) => id(candidate._id) === id(item.pharmacyDispenseLineId)) : null;
          if (!line || line.amount !== item.amount || line.quantity !== item.quantity || line.lineAmount !== item.totalItemAmount) add(codes, "invoice_source_conflict");
        }
        records.push({ invoiceId: id(row._id), expectedUpdatedAt: date(row.updatedAt), issues: codes.sort(), action: "preserve_issued_history" });
      }
    } else if (input.section === "register") {
      const rows = await page("scheduleh1registers", { locationId: scope.locationId }, { organizationId: 1, recordVersion: 1, dispenseId: 1, invoiceId: 1, medicineId: 1,
        prescriptionId: 1, clinicalNoteId: 1, doctorReviewRevision: 1, pharmacistReviewRevision: 1, classificationReviewReference: 1, dispensedAt: 1 });
      for (const row of rows) {
        const codes: string[] = [];
        if (id(row.organizationId) !== input.organizationId) add(codes, "organization_conflict");
        if (row.recordVersion !== 1 || !row.dispenseId || !row.invoiceId || !row.prescriptionId || !row.clinicalNoteId || !row.doctorReviewRevision || !row.pharmacistReviewRevision || !row.classificationReviewReference) add(codes, "register_historical_evidence_review");
        if (row.dispenseId) {
          const source = (await find("pharmacydispenses", { _id: row.dispenseId, organizationId: scope.organizationId, locationId: scope.locationId, invoiceId: row.invoiceId }, { _id: 1 }, 1))[0];
          evidence.push(source ?? null); if (!source) add(codes, "register_source_conflict");
        }
        records.push({ registerId: id(row._id), issues: codes.sort(), action: "preserve_issued_history" });
      }
    } else if (input.section === "access") {
      const subscriptions = await find("subscriptions", { organizationId: scope.organizationId }, { planId: 1, status: 1, entitlementSource: 1, currentPeriodStart: 1, currentPeriodEnd: 1,
        manualGrantedBy: 1, manualGrantedAt: 1, manualGrantReason: 1, commercialQuote: 1, updatedAt: 1 }, 11);
      const modules = await find("moduleregistries", { organizationId: scope.organizationId, moduleKey: "pharmacy" }, { enabled: 1, updatedAt: 1 }, 2);
      const globalCodes: string[] = [];
      if (subscriptions.length !== 1) add(globalCodes, "subscription_cardinality_review");
      for (const subscription of subscriptions) {
        if (subscription.commercialQuote) add(globalCodes, "captured_product_evidence_review");
        else add(globalCodes, "legacy_entitlement_mapping_review");
        if (subscription.entitlementSource === "manual" && (!subscription.manualGrantedBy || !date(subscription.manualGrantedAt) || !subscription.manualGrantReason)) add(globalCodes, "manual_grant_evidence_review");
      }
      if (modules.length !== 1 || typeof modules[0]?.enabled !== "boolean") add(globalCodes, "implicit_or_duplicate_module_review");
      if (!location.pharmacyCapability) add(globalCodes, "legacy_capability_mapping_review");
      evidence.push(subscriptions, modules);
      records.push({ kind: "organization_access", subscriptionCountAtLeast: subscriptions.length, relatedRowsComplete: subscriptions.length <= 10,
        pharmacyModule: modules.length === 1 ? modules[0].enabled : "review", capability: location.pharmacyCapability ? "configured" : "legacy_included",
        issues: globalCodes.sort(), action: "no_grant_activation" });
      const members = await page("orgmembers", { organizationId: scope.organizationId }, { role: 1, locationAccess: 1, updatedAt: 1 });
      for (const row of members) {
        const codes: string[] = [];
        if (!["all", "selected"].includes(row.locationAccess?.mode)) add(codes, "legacy_branch_grant_review");
        if (row.locationAccess?.mode === "selected") {
          const references = row.locationAccess.locationIds;
          if (!Array.isArray(references) || references.length > MAX_RELATED) add(codes, "branch_grant_reference_review");
          else if (references.length) {
            const owned = await find("locations", { _id: { $in: references }, organizationId: scope.organizationId }, { _id: 1 }, MAX_RELATED);
            evidence.push(owned); if (new Set(references.map(id)).size !== owned.length) add(codes, "branch_grant_reference_review");
          }
        }
        records.push({ memberId: id(row._id), issues: codes.sort(), action: "no_grant_activation" });
      }
    } else {
      for (const collection of ["medicines", "medicinebatches", "stockmovements", "invoices", "scheduleh1registers", "subscriptions"]) {
        let indexes: mongo.Document[];
        try { indexes = await db.collection(collection).listIndexes({ maxTimeMS: 8000 }).toArray(); }
        catch (error) { if (error instanceof mongo.MongoServerError && error.code === 26) indexes = []; else throw error; }
        const specs = indexes.map(index => ({ name: index.name, key: index.key, unique: index.unique === true, sparse: index.sparse === true,
          partialFilterExpression: index.partialFilterExpression ?? null, collation: index.collation ?? null, expireAfterSeconds: index.expireAfterSeconds ?? null })).sort((a, b) => a.name.localeCompare(b.name));
        evidence.push(specs); records.push({ collection, indexes: specs, action: "no_index_changes" });
      }
    }
    const report = {
      version: 1, readOnly: true, applySupported: false, organizationId: input.organizationId, locationId: input.locationId, snapshotId: input.snapshotId, asOf: input.asOf,
      section: input.section, cursor: input.cursor ?? null, limit: scope.limit, readIsolation: input.section === "indexes" ? "metadata_read" : "snapshot_per_page",
      countsScope: "this_page", nextCursor, pageComplete: nextCursor === null, rolloutApproved: false,
      issues: Object.fromEntries(Object.entries(issues).sort(([a], [b]) => a.localeCompare(b))), records, sourceFingerprint: hash(evidence),
    };
    // Abort even a successful review: there is no commit/apply path in this tool.
    if (session.inTransaction()) await session.abortTransaction();
    return { ...report, manifestFingerprint: hash(report) };
  } finally {
    if (session.inTransaction()) await session.abortTransaction();
    await session.endSession();
  }
}

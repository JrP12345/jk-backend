import type { FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { PharmacyImport } from "../models/PharmacyImport.ts";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { StockMovement } from "../models/StockMovement.ts";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { PharmacyParty } from "../models/PharmacyParty.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { importPreviewInput, importReference, importKind, type PharmacyImportKind } from "../schemas/pharmacyImports.ts";
import { PHARMACY_IMPORT_FIELDS } from "../schemas/pharmacyImports.ts";
import { identifier, calendarDate } from "../schemas/pharmacyPurchases.ts";
import { parsePharmacyCsv, csvWhole, csvPaise } from "../utilities/pharmacyCsv.ts";
import { catalogueFields, normalizeUnitDefinition } from "../utilities/medicineCatalogue.ts";
import { normalizeStockReceipt, receiptQuantity, lotExpiry } from "../utilities/pharmacyLot.ts";
import { getLocationTimezone, locationDateKey } from "../utilities/locationTime.ts";
import { decryptField } from "../utilities/cryptoEnvelope.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { CommandError, commandHash } from "./CommandReceiptService.ts";

export interface ImportRow { sourceLine: number; sourceId: string; sourceKey: string; fields: Record<string, string>; error?: string; data?: Record<string, any> }
export interface ImportUnit { sourceKey: string; rows: number[]; invalid: boolean; factHash: string; facts: Record<string, any> | Record<string, any>[] }
export interface ImportPayload { version: 1; kind: PharmacyImportKind; sourceReference: string; reviewReference: string; mapping: Record<string, string>; rows: ImportRow[]; units: ImportUnit[] }
export type ImportScope = Awaited<ReturnType<typeof purchaseScope>>;
export const importOperationScope = (scope: ImportScope, kind: PharmacyImportKind) => `pharmacy-import-source:${scope.organizationId}:${scope.locationId}:${kind}`;

export async function requireImportScope(req: FastifyRequest, locationId: unknown, kind: PharmacyImportKind) {
  const scope = await purchaseScope(req, locationId);
  const actions = kind === "catalogue" ? ["manageCatalog", "viewStock"] as const : kind === "opening_stock" ? ["receiveStock", "viewStock", "viewCost"] as const :
    kind === "supplier_dues" ? ["openingBalances", "viewPurchases"] as const : ["openingBalances", "viewReturns"] as const;
  for (const action of actions) if (!await pharmacyRequestAllows(req, action)) throw new CommandError(403, "Current import source and field permissions are required");
  return scope;
}
export async function inspectPharmacyImport(req: FastifyRequest) {
  const body = req.body as Record<string, unknown>, kind = importKind(body?.kind);
  await requireImportScope(req, body.locationId, kind);
  const parsed = parsePharmacyCsv(body.csv);
  return { headers: parsed.headers, rowCount: parsed.records.length, fields: PHARMACY_IMPORT_FIELDS[kind], optionalFields: ["barcode", "manufacturer", "strength", "reorderLevel"] };
}

export async function previewPharmacyImport(req: FastifyRequest) {
  const input = importPreviewInput(req.body), scope = await requireImportScope(req, input.locationId, input.kind), parsed = parsePharmacyCsv(input.csv);
  if (Object.values(input.mapping).some(header => !parsed.headers.includes(header))) throw new CommandError(400, "A mapped CSV column is missing");
  const fileHash = commandHash(input.csv), digest = commandHash({ version: 1, organizationId: scope.organizationId, locationId: scope.locationId, actorId: scope.actorId,
    kind: input.kind, fileHash, mapping: input.mapping, sourceReference: input.sourceReference, reviewReference: input.reviewReference });
  const existing = await PharmacyImport.findOne({ ...scope, digest });
  if (existing) return readPharmacyImport(req, existing.id, scope.locationId);
  const organization = await Organization.findById(scope.organizationId).select("currency countryCode").lean();
  if (organization?.currency !== "INR" || organization.countryCode !== "IN") throw new CommandError(409, "Import INR amounts require an explicit India/INR organization profile");
  const timezone = await getLocationTimezone(scope.locationId), today = locationDateKey(new Date(), timezone);
  const rows: ImportRow[] = parsed.records.map(record => {
    const fields = Object.fromEntries(Object.entries(input.mapping).map(([field, header]) => [field, record.cells[header]]));
    let sourceId = fields.sourceId?.trim() || "";
    const row: ImportRow = { sourceLine: record.sourceLine, sourceId, fields, sourceKey: commandHash({ locationId: scope.locationId, kind: input.kind, sourceReference: input.sourceReference,
      sourceId: input.kind === "opening_stock" ? fields.medicineId?.trim().toLowerCase() : sourceId }) };
    try {
      sourceId = importReference(sourceId, "source row ID"); row.sourceId = sourceId;
      if (input.kind === "catalogue") {
        if (!["general", "schedule_h", "schedule_h1", "schedule_x", "narcotic"].includes(fields.scheduleType)) throw new CommandError(400, "An explicit source schedule classification is required; sale approval remains separate");
        const metadata = catalogueFields({ name: fields.name, genericName: fields.genericName, category: fields.category, ...(fields.barcode ? { barcodes: [fields.barcode] } : {}),
          ...(fields.manufacturer ? { manufacturer: fields.manufacturer } : {}), ...(fields.strength ? { strength: fields.strength } : {}), ...(fields.reorderLevel ? { reorderLevel: csvWhole(fields.reorderLevel, "reorder level") } : {}) });
        const unitDefinition = normalizeUnitDefinition({ baseUnit: fields.baseUnit, packUnit: fields.packUnit, unitsPerPack: csvWhole(fields.unitsPerPack, "units per pack", 1_000_000) }, 1);
        row.data = { ...metadata, unitDefinition, scheduleType: fields.scheduleType, price: csvPaise(fields.sellingPrice, "selling price") / 100 };
      } else if (input.kind === "opening_stock") {
        const medicineId = identifier(fields.medicineId), unit = normalizeUnitDefinition({ baseUnit: fields.baseUnit, packUnit: fields.packUnit, unitsPerPack: csvWhole(fields.unitsPerPack, "units per pack", 1_000_000) }, 1);
        const receipt = normalizeStockReceipt({ locationId: scope.locationId, medicineId, receiptLineId: commandHash({ sourceReference: input.sourceReference, sourceId }), kind: "opening", expectedUnitVersion: 1,
          packs: csvWhole(fields.packs, "full packs"), looseUnits: csvWhole(fields.looseUnits, "loose units"), batchNumber: fields.batchNumber,
          expiry: { precision: fields.expiryPrecision, value: fields.expiry }, purchaseTotalPaise: csvPaise(fields.purchaseTotal, "total acquisition cost"), sellingPricePaise: csvPaise(fields.sellingPrice, "selling price"), mrpPaise: csvPaise(fields.mrp, "MRP"),
          openingSourceReference: `${input.sourceReference} / ${sourceId}` });
        if (lotExpiry(receipt.expiry, timezone).cutoff <= new Date()) throw new CommandError(400, "Expired stock cannot enter the saleable opening path");
        row.data = { ...receipt, unit, quantity: receiptQuantity(receipt, unit) };
      } else {
        const amountPaise = csvPaise(fields.amount, "opening due");
        if (!amountPaise) throw new CommandError(400, "Opening due must be positive");
        const sourceDate = calendarDate(fields.sourceDate);
        if (sourceDate > today) throw new CommandError(400, "Opening source cannot be dated in the future");
        row.data = { locationId: scope.locationId, partyId: identifier(fields.partyId), kind: input.kind === "supplier_dues" ? "supplier_due" : "customer_due", amountPaise,
          sourceDate, sourceReference: `${input.sourceReference} / ${sourceId}`, reviewReference: input.reviewReference, confirmedSource: true };
      }
    } catch (error) { row.error = error instanceof CommandError ? error.message : "Source row needs review"; }
    return row;
  });
  const sourceCounts = new Map<string, number>();
  for (const row of rows) row.sourceKey = commandHash({ locationId: scope.locationId, kind: input.kind, sourceReference: input.sourceReference,
    sourceId: input.kind === "opening_stock" ? row.fields.medicineId?.trim().toLowerCase() : row.sourceId });
  for (const row of rows) sourceCounts.set(row.sourceId, (sourceCounts.get(row.sourceId) || 0) + 1);
  for (const row of rows) if (sourceCounts.get(row.sourceId)! > 1) row.error = "Duplicate source row ID in this file; review both rows";
  // One bounded owned-source lookup per import, never a name/fuzzy match.
  if (input.kind === "catalogue") {
    const barcodes = rows.flatMap(row => row.data?.barcodes || []), occurrences = new Map<string, number>();
    for (const barcode of barcodes) occurrences.set(barcode, (occurrences.get(barcode) || 0) + 1);
    const assigned = await Medicine.find({ locationId: scope.locationId, deletedAt: null, barcodes: { $in: barcodes } }).select("barcodes").limit(201).lean();
    for (const row of rows.filter(row => row.data && !row.error)) if ((row.data!.barcodes || []).some((barcode: string) => occurrences.get(barcode)! > 1 || assigned.some(product => product.barcodes?.includes(barcode)))) row.error = "Barcode is repeated in this file or already assigned; review the actual source identity";
  } else if (input.kind === "opening_stock") {
    const ids = rows.filter(row => row.data).map(row => row.data!.medicineId);
    const medicines = await Medicine.aggregate([
      { $match: { _id: { $in: ids.map(id => new mongoose.Types.ObjectId(id)) }, locationId: new mongoose.Types.ObjectId(scope.locationId), deletedAt: null } },
      ...[MedicineBatch.collection.name, StockMovement.collection.name].map((collection, index) => ({ $lookup: { from: collection, let: { medicine: "$_id" },
        pipeline: [{ $match: { $expr: { $eq: ["$medicineId", "$$medicine"] } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: `history${index}` } })),
      { $project: { unitDefinition: 1, stockQuantity: 1, hasHistory: { $or: [{ $gt: [{ $size: "$history0" }, 0] }, { $gt: [{ $size: "$history1" }, 0] }] } } },
    ]).option({ maxTimeMS: 5000 });
    for (const row of rows.filter(row => row.data && !row.error)) {
      const medicine = medicines.find(item => String(item._id) === row.data!.medicineId), expected = row.data!.unit;
      if (!medicine?.unitDefinition || (["baseUnit", "packUnit", "unitsPerPack"] as const).some(field => medicine.unitDefinition![field] !== expected[field])) row.error = "Owned product and explicit source units must match; create/review the empty catalogue item first";
      else {
        row.data!.expectedUnitVersion = medicine.unitDefinition.version; delete row.data!.unit;
        if (medicine.stockQuantity !== 0 || medicine.hasHistory) row.error = "Opening import requires an empty product with no prior stock history; recover an existing source or use the reviewed correction workflow";
      }
    }
  } else if (input.kind.endsWith("dues")) {
    const parties = await PharmacyParty.find({ _id: { $in: rows.filter(row => row.data).map(row => row.data!.partyId) }, organizationId: scope.organizationId, locationIds: scope.locationId, archived: false,
      kinds: input.kind === "supplier_dues" ? "supplier" : "customer" }).select("revision").lean();
    for (const row of rows.filter(row => row.data && !row.error)) {
      const party = parties.find(item => String(item._id) === row.data!.partyId);
      if (!party) row.error = "Owned source party is unavailable; select its actual party ID";
      else row.data!.expectedPartyRevision = party.revision;
    }
  }
  const grouped = new Map<string, ImportRow[]>();
  for (const row of rows) grouped.set(row.sourceKey, [...(grouped.get(row.sourceKey) || []), row]);
  const units: ImportUnit[] = [...grouped].map(([sourceKey, groupedRows]) => {
    const normalized = groupedRows.filter(row => row.data).sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0).map(row => {
      const { expectedPartyRevision: _revision, reviewReference: _review, quantity: _quantity, unit: _unit, ...facts } = row.data!;
      return facts;
    });
    const facts = input.kind === "opening_stock" ? normalized : normalized[0] || {};
    return { sourceKey, rows: groupedRows.map(row => row.sourceLine), invalid: groupedRows.some(row => Boolean(row.error)), facts,
      factHash: commandHash({ version: 1, kind: input.kind, sourceReference: input.sourceReference, facts }) };
  });
  const payload: ImportPayload = { version: 1, kind: input.kind, sourceReference: input.sourceReference, reviewReference: input.reviewReference, mapping: input.mapping, rows, units };
  try {
    await withTransaction(async session => {
      // Serialize the source-file binding with another preview in this branch.
      // Mapping/review revisions may create another manifest; identical file bytes
      // cannot silently become another physical source under a different label.
      const pinned = await Location.findOneAndUpdate({ _id: scope.locationId, organizationId: scope.organizationId }, { $inc: { __v: 1 } }, { session });
      if (!pinned) throw new CommandError(404, "Import location is unavailable");
      const sameFile = await PharmacyImport.findOne({ organizationId: scope.organizationId, locationId: scope.locationId, kind: input.kind, fileHash }).select("+payloadCiphertext").session(session).maxTimeMS(5000);
      if (sameFile) {
        const prior = JSON.parse(decryptField(sameFile.payloadCiphertext)) as ImportPayload;
        if (prior.sourceReference !== input.sourceReference) throw new CommandError(409, "These exact file bytes already identify a reviewed source. Recover the saved import and retain its original source reference");
      }
      const manifest = await createWithSession<InstanceType<typeof PharmacyImport>>(PharmacyImport, { ...scope, kind: input.kind, digest, fileHash, payloadCiphertext: JSON.stringify(payload) }, session);
      await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_IMPORT_REVIEWED", category: "ADMIN", targetModel: "PharmacyImport", targetId: manifest._id,
        details: { kind: input.kind, digest, fileHash, rows: rows.length, invalidRows: rows.filter(row => row.error).length } }, session);
    });
  } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  const manifest = await PharmacyImport.findOne({ ...scope, digest });
  if (!manifest) throw new CommandError(409, "Import preview needs reconciliation; submit the same file and mapping");
  return readPharmacyImport(req, manifest.id, scope.locationId);
}

export async function loadPharmacyImport(req: FastifyRequest, id: string, locationId: unknown) {
  const scope = await purchaseScope(req, locationId);
  const manifest = await PharmacyImport.findOne({ _id: identifier(id), ...scope }).select("+payloadCiphertext");
  if (!manifest) throw new CommandError(404, "Reviewed import is unavailable for this operator");
  await requireImportScope(req, scope.locationId, importKind(manifest.kind));
  let payload: ImportPayload;
  try { payload = JSON.parse(decryptField(manifest.payloadCiphertext)); } catch { throw new CommandError(409, "Import source evidence needs review"); }
  if (payload.version !== 1 || payload.kind !== manifest.kind || !Array.isArray(payload.rows) || !Array.isArray(payload.units)) throw new CommandError(409, "Import source evidence needs review");
  return { scope, manifest, payload };
}
export async function readPharmacyImport(req: FastifyRequest, id: string, locationId: unknown) {
  const { scope, manifest, payload } = await loadPharmacyImport(req, id, locationId);
  const receipts = await OperationReceipt.find({ scope: importOperationScope(scope, payload.kind), key: { $in: payload.units.map(unit => unit.sourceKey) } }).select("+responseCiphertext").lean();
  const units = payload.units.map(unit => {
    const receipt = receipts.find((item: any) => item.key === unit.sourceKey);
    let status = unit.invalid ? "invalid" : manifest.sourceErrors.get(unit.sourceKey) ? "failed" : "unprocessed", result: unknown = null, error = manifest.sourceErrors.get(unit.sourceKey) || null;
    if (receipt) {
      if (receipt.requestHash !== unit.factHash) { status = "conflict"; error = "This actual source was already posted with different facts; review its original result before any correction"; }
      else if (receipt.resultId && receipt.responseCiphertext) {
        try {
          const saved = JSON.parse(decryptField(receipt.responseCiphertext)), data = saved.data;
          const identity = payload.kind === "catalogue" ? data?.medicineId : payload.kind === "opening_stock" ? data?.lots?.[0]?.batchId : data?.openingBalanceId;
          if (saved.version !== 1 || !data || identity !== String(receipt.resultId)) throw new Error("Source result differs");
          result = data; status = "posted"; error = null;
        } catch { status = "unknown"; error = "Committed source result needs review; retain this manifest"; }
      } else { status = "unknown"; error = "Source outcome is not confirmed; retain this manifest and check again"; }
    }
    return { sourceKey: unit.sourceKey, sourceLines: unit.rows, status, error, result };
  });
  const validRows = payload.rows.filter(row => row.data && (!payload.units.find(unit => unit.sourceKey === row.sourceKey)!.invalid || units.find(unit => unit.sourceKey === row.sourceKey)?.status === "posted"));
  const quantities = new Map<string, number>();
  let acquisitionPaise = 0, duesPaise = 0;
  for (const row of validRows) {
    if (payload.kind === "opening_stock") {
      const unit = row.fields.baseUnit, total = (quantities.get(unit) || 0) + row.data!.quantity;
      if (!Number.isSafeInteger(total)) throw new CommandError(400, "Opening quantity total exceeds its safe bound; split the source file");
      quantities.set(unit, total); acquisitionPaise += row.data!.purchaseTotalPaise;
    } else if (payload.kind.endsWith("dues")) duesPaise += row.data!.amountPaise;
  }
  return { id: manifest.id, locationId: scope.locationId, kind: payload.kind, digest: manifest.digest, fileHash: manifest.fileHash, sourceReference: payload.sourceReference, reviewReference: payload.reviewReference,
    rows: payload.rows.map(row => ({ sourceLine: row.sourceLine, sourceId: row.sourceId, sourceKey: row.sourceKey, fields: row.fields, error: units.find(unit => unit.sourceKey === row.sourceKey)?.status === "posted" ? null : row.error || null })), units,
    counts: { posted: units.filter(unit => unit.status === "posted").length, invalid: units.filter(unit => unit.status === "invalid").length, failed: units.filter(unit => ["failed", "conflict", "unknown"].includes(unit.status)).length, unprocessed: units.filter(unit => unit.status === "unprocessed").length },
    totals: { basis: "valid_preview_rows", validRows: validRows.length, invalidRows: payload.rows.length - validRows.length, acquisitionPaise, duesPaise,
      baseQuantities: [...quantities].map(([baseUnit, quantity]) => ({ baseUnit, quantity })) } };
}

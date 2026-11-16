import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Medicine } from "../models/Medicine.ts";
import { identifier, object, purchaseLineInput, text, whole } from "../schemas/pharmacyPurchases.ts";
import { csvPaise, csvWhole, parsePharmacyCsv } from "../utilities/pharmacyCsv.ts";
import { normalizeUnitDefinition, toBaseUnits } from "../utilities/medicineCatalogue.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { scopedParty } from "./PharmacyPurchaseDraftService.ts";
import { PharmacyPurchaseCsvFormat, PharmacySupplierItemMapping } from "../models/PharmacyPurchaseCsvMapping.ts";
import { purchaseCsvFormatId, purchaseCsvFormatKey, purchaseCsvIdentityHash, purchaseCsvItemId } from "../utilities/pharmacyPurchaseCsvMapping.ts";

export const purchaseCsvFields = ["source", "packs", "looseUnits", "freePacks", "freeLooseUnits", "baseAmount", "discount", "gst", "hsn", "sellingPrice", "mrp"] as const;
const requiredFields = ["source", "baseAmount", "gst", "hsn", "sellingPrice"];

async function source(req: FastifyRequest, preview: boolean, remembering: boolean) {
  const body = object(req.body, ["locationId", "supplierId", "csv", ...(preview ? ["mapping", "matches", "priceBasis"] : []), ...(remembering ? ["expectedRevision", "confirmedMappings"] : [])]);
  const { scope, party } = await scopedParty(req, identifier(body.supplierId), body.locationId), parsed = parsePharmacyCsv(body.csv);
  if (party.archived || !party.kinds.includes("supplier")) throw new CommandError(409, "Choose an active supplier before preparing purchase CSV lines");
  if (parsed.records.length > 100) throw new CommandError(400, "A purchase CSV supports at most 100 lines from one supplier invoice");
  const input: Record<string, any> = { ...body, supplierId: String(party._id) };
  return { body: input, scope, ...parsed };
}

export async function inspectPurchaseCsv(req: FastifyRequest) {
  const { body, scope, headers, records } = await source(req, false, false);
  const formatKey = purchaseCsvFormatKey(headers), id = purchaseCsvFormatId(scope.organizationId, scope.locationId, body.supplierId, formatKey);
  const format = await PharmacyPurchaseCsvFormat.findById(id).lean();
  const identity = { locationId: scope.locationId, supplierId: body.supplierId, formatKey };
  if (!format) return { ...identity, headers, records, fields: purchaseCsvFields, profile: null };
  const mapping = format.mapping as unknown as Record<string, string>, sourceColumn = mapping.source;
  const values = [...new Set(records.map(row => row.cells[sourceColumn]?.trim()).filter((value): value is string => Boolean(value)))];
  const items = await PharmacySupplierItemMapping.find({ _id: { $in: values.map(value => purchaseCsvItemId(id, sourceColumn, value)) }, formatId: id }).limit(100).lean();
  const medicines = await Medicine.find({ _id: { $in: items.map(item => item.medicineId) }, locationId: scope.locationId, deletedAt: null })
    .select("name genericName strength manufacturer price hsnCode unitDefinition").limit(100).maxTimeMS(3000).lean();
  const matches = items.map(item => {
    const medicine = medicines.find(row => String(row._id) === String(item.medicineId));
    if (!medicine?.unitDefinition || purchaseCsvIdentityHash(medicine) !== item.identityHash) return { sourceValue: item.sourceValue, product: null, error: "Saved medicine details or pack units changed; match this item again" };
    return { sourceValue: item.sourceValue, error: null, product: { id: String(medicine._id), name: medicine.name, genericName: medicine.genericName, strength: medicine.strength,
      manufacturer: medicine.manufacturer, price: medicine.price, hsnCode: medicine.hsnCode, unitDefinition: normalizeUnitDefinition(medicine.unitDefinition, medicine.unitDefinition.version), identityHash: item.identityHash } };
  });
  return { ...identity, headers, records, fields: purchaseCsvFields, profile: { revision: format.revision, mapping, priceBasis: format.priceBasis, matches } };
}

/** Read-only preparation. Applying a preview does not create a purchase or receive stock. */
export async function previewPurchaseCsv(req: FastifyRequest, remembering = false) {
  const { body, scope, headers, records } = await source(req, true, remembering);
  if (!["base_unit", "pack"].includes(body.priceBasis)) throw new CommandError(400, "Select whether CSV selling price and MRP are per base unit or per full pack");
  const mapping = object(body.mapping, [...purchaseCsvFields]);
  const columns = Object.values(mapping);
  if (columns.some(column => typeof column !== "string" || !headers.includes(column)) || new Set(columns).size !== columns.length ||
      requiredFields.some(field => !mapping[field]) || !mapping.packs && !mapping.looseUnits) throw new CommandError(400, "Map distinct source columns, required amounts/tax fields and at least one billed quantity column");
  if (!Array.isArray(body.matches) || body.matches.length > 100) throw new CommandError(400, "Select the existing medicine for each source item");
  const matches = new Map<string, { medicineId: string; expectedUnitVersion: number; expectedIdentityHash?: string }>();
  for (const raw of body.matches) {
    const match = object(raw, ["sourceValue", "medicineId", "expectedUnitVersion", "expectedIdentityHash"]), value = text(match.sourceValue, "source item", 1, 2000);
    if (matches.has(value)) throw new CommandError(400, "Source item matches must be distinct");
    if ((remembering || match.expectedIdentityHash !== undefined) && (typeof match.expectedIdentityHash !== "string" || !/^[a-f\d]{64}$/.test(match.expectedIdentityHash))) throw new CommandError(400, "Preview the medicine identities before remembering matches");
    matches.set(value, { medicineId: identifier(match.medicineId), expectedUnitVersion: whole(match.expectedUnitVersion, "unit version", Number.MAX_SAFE_INTEGER),
      ...(match.expectedIdentityHash !== undefined ? { expectedIdentityHash: match.expectedIdentityHash } : {}) });
  }
  const medicines = await Medicine.find({ locationId: scope.locationId, deletedAt: null, _id: { $in: [...matches.values()].map(match => match.medicineId) } })
    .select("name genericName strength manufacturer price hsnCode unitDefinition").limit(100).maxTimeMS(3000).lean();
  const rows = records.map(record => {
    const cell = (field: string) => mapping[field] ? record.cells[mapping[field]].trim() : undefined;
    const sourceValue = cell("source") || "";
    try {
      const match = matches.get(sourceValue), medicine = match && medicines.find(row => String(row._id) === match.medicineId);
      if (!sourceValue || !medicine?.unitDefinition || medicine.unitDefinition.version !== match!.expectedUnitVersion) throw new CommandError(409, "Select a current medicine from this branch and review its pack units");
      if (match!.expectedIdentityHash && match!.expectedIdentityHash !== purchaseCsvIdentityHash(medicine)) throw new CommandError(409, "Medicine details changed; match this source item again before continuing");
      const unit = normalizeUnitDefinition(medicine.unitDefinition, medicine.unitDefinition.version);
      const count = (field: string) => cell(field) === undefined ? 0 : csvWhole(cell(field)!, field);
      const amount = (field: string, optional = false) => cell(field) === undefined && optional ? 0 : csvPaise(cell(field) ?? "", field);
      const unitPrice = (field: string) => {
        const price = amount(field);
        if (body.priceBasis === "base_unit") return price;
        if (price % unit.unitsPerPack !== 0) throw new CommandError(400, `${field} per pack does not convert to whole paise per ${unit.baseUnit}; review an explicit per-unit price instead of rounding`);
        return price / unit.unitsPerPack;
      };
      const line = purchaseLineInput({ lineId: crypto.randomUUID(), medicineId: String(medicine._id), expectedUnitVersion: unit.version,
        packs: count("packs"), looseUnits: count("looseUnits"), freePacks: count("freePacks"), freeLooseUnits: count("freeLooseUnits"),
        baseAmountPaise: amount("baseAmount"), discountPaise: amount("discount", true), gstRateBps: amount("gst"), hsnCode: cell("hsn"),
        sellingPricePaise: unitPrice("sellingPrice"), ...(cell("mrp") ? { mrpPaise: unitPrice("mrp") } : {}) });
      const billed = toBaseUnits(line.packs, unit.unitsPerPack) + line.looseUnits, free = toBaseUnits(line.freePacks, unit.unitsPerPack) + line.freeLooseUnits;
      if (line.looseUnits >= unit.unitsPerPack || line.freeLooseUnits >= unit.unitsPerPack || !Number.isSafeInteger(billed + free) || billed + free <= 0 || billed === 0 && line.baseAmountPaise !== 0) throw new CommandError(400, "Check positive quantities, loose units smaller than one pack and free-only line amounts");
      return { sourceLine: record.sourceLine, sourceValue, error: null, line, product: { id: String(medicine._id), name: medicine.name, genericName: medicine.genericName,
        strength: medicine.strength, manufacturer: medicine.manufacturer, price: medicine.price, hsnCode: medicine.hsnCode, unitDefinition: unit, identityHash: purchaseCsvIdentityHash(medicine) } };
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      return { sourceLine: record.sourceLine, sourceValue, error: (error as Error).message, line: null, product: null };
    }
  });
  return { rows, ignoredColumns: headers.filter(header => !columns.includes(header)) };
}

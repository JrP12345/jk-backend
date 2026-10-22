import { CommandError } from "../services/CommandReceiptService.ts";
import { object, identifier, text } from "./pharmacyPurchases.ts";

export const PHARMACY_IMPORT_FIELDS = {
  catalogue: ["sourceId", "name", "genericName", "category", "scheduleType", "baseUnit", "packUnit", "unitsPerPack", "sellingPrice", "barcode", "manufacturer", "strength", "reorderLevel"],
  opening_stock: ["sourceId", "medicineId", "baseUnit", "packUnit", "unitsPerPack", "packs", "looseUnits", "batchNumber", "expiryPrecision", "expiry", "purchaseTotal", "sellingPrice", "mrp"],
  customer_dues: ["sourceId", "partyId", "sourceDate", "amount"],
  supplier_dues: ["sourceId", "partyId", "sourceDate", "amount"],
} as const;
export type PharmacyImportKind = keyof typeof PHARMACY_IMPORT_FIELDS;
const optional = new Set(["barcode", "manufacturer", "strength", "reorderLevel"]);
export function importKind(value: unknown): PharmacyImportKind {
  if (typeof value !== "string" || !Object.hasOwn(PHARMACY_IMPORT_FIELDS, value)) throw new CommandError(400, "Choose catalogue, opening_stock, customer_dues or supplier_dues");
  return value as PharmacyImportKind;
}
export function importReference(value: unknown, name: string, maximum = 50) {
  const normalized = text(value, name, 1, maximum).normalize("NFKC");
  if (normalized.length > maximum || /[\p{Cc}\p{Cf}]/u.test(normalized)) throw new CommandError(400, `${name} cannot contain control/format characters or exceed ${maximum} characters`);
  return normalized;
}
export function importPreviewInput(raw: unknown) {
  const body = object(raw, ["locationId", "kind", "csv", "mapping", "sourceReference", "reviewReference", "organizationId", "organization_id"]);
  const kind = importKind(body.kind), fields = PHARMACY_IMPORT_FIELDS[kind];
  const mapping = object(body.mapping, [...fields]);
  if (Object.entries(mapping).some(([, header]) => typeof header !== "string" || !header.trim()) || fields.some(field => !optional.has(field) && !Object.hasOwn(mapping, field)) ||
      new Set(Object.values(mapping)).size !== Object.keys(mapping).length) throw new CommandError(400, "Map each required field to a distinct CSV column");
  if (typeof body.csv !== "string") throw new CommandError(400, "CSV text is required");
  return { locationId: identifier(body.locationId), kind, csv: body.csv, mapping: mapping as Record<string, string>,
    sourceReference: importReference(body.sourceReference, "actual import source"), reviewReference: text(body.reviewReference, "import source review", 3, 200) };
}
export function importCommitInput(raw: unknown) {
  const body = object(raw, ["locationId", "expectedDigest", "sourceKeys", "confirmedSource", "organizationId", "organization_id"]);
  if (body.confirmedSource !== true || typeof body.expectedDigest !== "string" || !/^[a-f\d]{64}$/.test(body.expectedDigest) ||
      !Array.isArray(body.sourceKeys) || body.sourceKeys.length < 1 || body.sourceKeys.length > 10 || body.sourceKeys.some(key => typeof key !== "string" || !/^[a-f\d]{64}$/.test(key)) ||
      new Set(body.sourceKeys).size !== body.sourceKeys.length) throw new CommandError(400, "Confirm the reviewed manifest and choose 1 to 10 distinct source units");
  return { locationId: identifier(body.locationId), expectedDigest: body.expectedDigest, sourceKeys: body.sourceKeys as string[], confirmedSource: true };
}

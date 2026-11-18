import { CommandError, commandHash } from "../services/CommandReceiptService.ts";
import { object, text } from "../schemas/pharmacyPurchases.ts";
import { normalizeBarcodes } from "./medicineCatalogue.ts";
import { medicineSearchValue, normalizeMedicineSearch } from "./medicineSearchIndex.ts";

export const catalogueProviders = ["cdci", "abdm", "evitalrx", "reviewed"] as const;
export type CatalogueProvider = typeof catalogueProviders[number];
export const catalogueIdentityFields = ["sourceId", "name", "genericName", "composition", "strength", "dosageForm", "manufacturer", "supplierName", "sourceIds", "sourceUpdatedOn", "packSize", "barcodes"] as const;
export function normalizeGlobalProduct(raw: unknown) {
  const row = object(raw, [...catalogueIdentityFields]);
  const optional = (key: string, max: number) => row[key] === undefined || row[key] === "" ? "" : text(row[key], key, 1, max);
  const ids = object(row.sourceIds ?? {}, ["product", "generic", "supplier", "substances", "dosageForms", "routes"]);
  const sourceIds: { product?: string; generic?: string; supplier?: string; substances?: string[]; dosageForms?: string[]; routes?: string[] } = {};
  for (const field of ["product", "generic", "supplier"] as const) if (ids[field] !== undefined) sourceIds[field] = text(ids[field], "external reference ID", 1, 200);
  for (const field of ["substances", "dosageForms", "routes"] as const) if (ids[field] !== undefined) {
    if (!Array.isArray(ids[field]) || ids[field].length > 100) throw new CommandError(400, "Invalid source reference list");
    sourceIds[field] = [...new Set<string>(ids[field].map((id: unknown) => text(id, "external reference ID", 1, 200)))];
  }
  const sourceUpdatedOn = optional("sourceUpdatedOn", 8);
  if (sourceUpdatedOn) {
    const date = new Date(`${sourceUpdatedOn.slice(0, 4)}-${sourceUpdatedOn.slice(4, 6)}-${sourceUpdatedOn.slice(6, 8)}T00:00:00Z`);
    if (!/^\d{8}$/.test(sourceUpdatedOn) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replaceAll("-", "") !== sourceUpdatedOn) throw new CommandError(400, "Invalid source update date");
  }
  const values = { sourceId: text(row.sourceId, "external source ID", 1, 200), name: text(row.name, "product name", 1, 200),
    genericName: optional("genericName", 500), composition: optional("composition", 500), strength: optional("strength", 80),
    dosageForm: optional("dosageForm", 100), manufacturer: optional("manufacturer", 200), supplierName: optional("supplierName", 200), sourceIds, sourceUpdatedOn, packSize: optional("packSize", 200),
    barcodes: normalizeBarcodes(row.barcodes ?? []) };
  if (Object.values(values).some(value => typeof value === "string" && /[\p{Cc}\p{Cf}]/u.test(value))) throw new CommandError(400, "Catalogue identity cannot contain control characters");
  return { ...values, search: medicineSearchValue([values.name, values.genericName, values.composition, values.strength, values.dosageForm, values.manufacturer, values.supplierName].join(" ")), rowSha256: commandHash(values) };
}
/** Documented provider shape only; importing it still requires reviewed storage/redistribution rights. */
export function normalizeEVitalProduct(row: Record<string, unknown>) {
  return normalizeGlobalProduct({ sourceId: row.medicine_id, name: row.medicine_name, composition: row.content,
    dosageForm: row.dosage_type, packSize: row.packing_size, manufacturer: row.manufacturer_name });
}
/** Conservative duplicate key. Similar names never authorize a clinical match. */
export function catalogueIdentity(row: Record<string, any>) {
  return commandHash([row.name, row.genericName, row.strength, row.manufacturer, row.category,
    row.unitDefinition?.baseUnit, row.unitDefinition?.packUnit, String(row.unitDefinition?.unitsPerPack ?? "")].map(value => normalizeMedicineSearch(value || "")));
}

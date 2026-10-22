import { CommandError } from "../services/CommandReceiptService.ts";

export const MEDICINE_FORMS = ["tablet", "capsule", "syrup", "injection", "ointment", "drops", "inhaler", "other"] as const;
export const MEDICINE_BASE_UNITS = ["tablet", "capsule", "ml", "g", "piece", "dose"] as const;
export const MEDICINE_PACK_UNITS = ["strip", "box", "bottle", "vial", "tube", "ampoule", "sachet", "pack", "piece"] as const;
/** Run before schema coercion: null or numeric strings cannot become stock or money. */
export function assertMedicineBodyTypes(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CommandError(400, "A medicine object is required");
  const body = input as Record<string, unknown>;
  for (const key of ["stockQuantity", "price", "costPrice", "reorderLevel", "gstRate", "expectedUnitVersion"]) {
    if (body[key] !== undefined && (typeof body[key] !== "number" || !Number.isFinite(body[key]))) throw new CommandError(400, `${key} must be a finite number`);
  }
  for (const key of ["name", "genericName", "manufacturer", "strength", "category", "scheduleType", "hsnCode", "expiryDate", "batchNumber"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") throw new CommandError(400, `${key} must be a string`);
  }
  if (body.barcodes !== undefined) normalizeBarcodes(body.barcodes);
  if (body.unitDefinition !== undefined) {
    if (!body.unitDefinition || typeof body.unitDefinition !== "object" || Array.isArray(body.unitDefinition)) throw new CommandError(400, "An explicit unit definition is required");
    const unit = body.unitDefinition as Record<string, unknown>;
    if (typeof unit.unitsPerPack !== "number") throw new CommandError(400, "Units per pack must be numeric");
  }
}
export function normalizeBarcodes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > 20 || input.some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(value.trim()))) throw new CommandError(400, "Provide up to 20 nonempty barcode aliases, each at most 64 characters");
  const result = input.map(value => (value as string).trim());
  if (new Set(result).size !== result.length) throw new CommandError(400, "Barcode aliases must be distinct");
  return result;
}
export function toBaseUnits(packs: number, unitsPerPack: number) {
  const result = packs * unitsPerPack;
  if (!Number.isSafeInteger(packs) || packs < 0 || !Number.isSafeInteger(unitsPerPack) || unitsPerPack < 1 || unitsPerPack > 1_000_000 || !Number.isSafeInteger(result)) throw new CommandError(400, "Unit conversion must use bounded positive factors and safe whole quantities");
  return result;
}
export function normalizeUnitDefinition(input: unknown, version: number) {
  const unit = input as { baseUnit?: string; packUnit?: string; unitsPerPack?: number } | null;
  if (!unit || !MEDICINE_BASE_UNITS.includes(unit.baseUnit as typeof MEDICINE_BASE_UNITS[number]) || !MEDICINE_PACK_UNITS.includes(unit.packUnit as typeof MEDICINE_PACK_UNITS[number])) throw new CommandError(400, "Select an explicit base unit and pack unit");
  toBaseUnits(1, unit.unitsPerPack!);
  return { version, baseUnit: unit.baseUnit as typeof MEDICINE_BASE_UNITS[number], packUnit: unit.packUnit as typeof MEDICINE_PACK_UNITS[number], unitsPerPack: unit.unitsPerPack! };
}
export function catalogueFields(body: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, max] of [["name", 200], ["genericName", 500], ["manufacturer", 200], ["strength", 80]] as const) if (body[key] !== undefined) {
    const value = body[key];
    if (typeof value !== "string" || value.trim().length > max || ["name", "genericName"].includes(key) && !value.trim()) throw new CommandError(400, `Invalid ${key}`);
    result[key] = value.trim();
  }
  if (body.category !== undefined) {
    if (!MEDICINE_FORMS.includes(body.category as typeof MEDICINE_FORMS[number])) throw new CommandError(400, "Invalid medicine form");
    result.category = body.category;
  }
  if (body.reorderLevel !== undefined) {
    if (!Number.isSafeInteger(body.reorderLevel) || (body.reorderLevel as number) < 0) throw new CommandError(400, "Reorder level must be a non-negative safe integer");
    result.reorderLevel = body.reorderLevel;
  }
  if (body.barcodes !== undefined) result.barcodes = normalizeBarcodes(body.barcodes);
  return result;
}

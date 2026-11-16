import { commandHash } from "../services/CommandReceiptService.ts";

export const purchaseCsvFormatKey = (headers: string[]) => commandHash([...headers].sort());
export const purchaseCsvFormatId = (organizationId: string, locationId: string, supplierId: string, formatKey: string) => commandHash([organizationId, locationId, supplierId, formatKey]);
export const purchaseCsvItemId = (formatId: string, sourceColumn: string, sourceValue: string) => commandHash([formatId, sourceColumn, sourceValue]);
export function purchaseCsvIdentityHash(medicine: { name: string; genericName?: string | null; strength?: string | null; manufacturer?: string | null; unitDefinition?: unknown }) {
  const unit = medicine.unitDefinition as { version: number; baseUnit: string; packUnit: string; unitsPerPack: number } | undefined;
  return commandHash([medicine.name, medicine.genericName || "", medicine.strength || "", medicine.manufacturer || "", unit ? [unit.version, unit.baseUnit, unit.packUnit, unit.unitsPerPack] : null]);
}

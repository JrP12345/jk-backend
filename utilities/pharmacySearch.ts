import { CommandError } from "../services/CommandReceiptService.ts";
import { medicineSearchAnchor, medicineSearchFields, normalizeMedicineSearch } from "./medicineSearchIndex.ts";

export const normalizePharmacySearch = normalizeMedicineSearch;
export const escapePharmacySearch = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Literal terms, never fuzzy substitution or a source of dispensing authority. */
export function medicineSearchFilter(search: string) {
  const terms = [...new Set(normalizePharmacySearch(search).split(" ").filter(Boolean))];
  if (terms.length > 8) throw new CommandError(400, "Search medicines with up to eight words");
  return terms.length ? { $and: terms.map(term => {
    const match = new RegExp(escapePharmacySearch(term));
    return { $or: medicineSearchFields.map(field => ({ [`searchIndex.${field}.grams`]: medicineSearchAnchor(term), [`searchIndex.${field}.value`]: match })) };
  }) } : {};
}

export function customerSearchFilter(search: string) {
  const normalized = normalizePharmacySearch(search);
  if (!normalized) return {};
  const digits = normalized.replace(/\D/g, "");
  if (/^[+\d\s().-]+$/.test(normalized) && digits.length >= 3) {
    // Match formatted stored numbers without dropping leading zeroes or requiring a country code.
    return { $or: [{ normalizedName: { $regex: `^${escapePharmacySearch(normalized)}` } }, { phone: { $regex: digits.split("").join("[\\s()+.\\-]*") } }] };
  }
  return { normalizedName: { $regex: `^${escapePharmacySearch(normalized)}` } };
}

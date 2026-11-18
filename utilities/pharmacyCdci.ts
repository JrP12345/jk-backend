import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { CommandError } from "../services/CommandReceiptService.ts";
import { normalizeGlobalProduct } from "./pharmacyGlobalCatalogue.ts";

export const CDCI_LIMITS = { compressedBytes: 32_000_000, expandedBytes: 96_000_000, fileBytes: 32_000_000, entries: 64, rows: 150_000, cell: 20_000 } as const;
export const CDCI_MAPPING_VERSION = "cdci-flat-2026-11-16-v1";
const columns = {
  "BrandMaster.txt": ["Identifier", "Brand Name", "Product Identifier", "Supplier Identifier", "Generic Identifier", "License Number", "License Status", "Excipient", "last_updated_on"],
  "GenericMaster.txt": ["Identifier", "Generic Name", "Substance Identifier", "Route of Administration", "Dose Form", "Therapeutic Role", "Indication", "Contra Indication", "Interaction with Drugs", "Classification of Drugs", "Source/ Regulatory", "last_updated_on"],
  "ProductMaster.txt": ["Identifier", "Product Name"],
  "SupplierMaster.txt": ["Identifier", "Supplier Name", "Country"],
  "SubstanceMaster.txt": ["Identifier", "Substance Name", "CAS Number", "UNII", "Substance Description", "Molecular Weight", "Toxicity", "SMILE", "InChI", "IUPAC Name", "Molecular Formula", "last_updated_on"],
  "DrugFormMaster.txt": ["Id", "Dose Form"],
  "RouteOfAdministrationMaster.txt": ["Identifier", "RouteOfAdministration"],
} as const;
type Master = keyof typeof columns;
type Row = Record<string, string>;
export interface CdciPackage { tables: Record<Master, Map<string, Row>>; packageSha256: string; licenceSha256: string; licence: string; fileHashes: Record<string, string>; newestRecordDate: string }
const invalid = (message: string): never => { throw new CommandError(400, message); };
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const decode = (value: Uint8Array) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(value); } catch { return invalid("CDCI files must be valid UTF-8"); } };
function parseMaster(file: Master, bytes: Uint8Array) {
  const source = decode(bytes).replace(/^\uFEFF/, ""), expected = columns[file];
  const table = new Map<string, Row>();
  let at = 0, line = 0;
  while (at < source.length) {
    const end = source.indexOf("\n", at), physical = source.slice(at, end < 0 ? source.length : end).replace(/\r$/, "");
    at = end < 0 ? source.length : end + 1; line++;
    if (!physical.trim()) continue;
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(physical)) invalid(`${file} line ${line}: unsupported control characters`);
    const cells = physical.split("\t");
    // The supplied release has a final empty tab beyond the documented header.
    while (cells.length > expected.length && cells.at(-1) === "") cells.pop();
    if (cells.length > expected.length || cells.length < 2 || cells.some(cell => cell.length > CDCI_LIMITS.cell)) invalid(`${file} line ${line}: unexpected columns or oversized field`);
    if (line === 1) {
      if (cells.length !== expected.length || cells.some((cell, index) => cell !== expected[index])) invalid(`${file}: headers changed; review the release mapping before importing`);
      continue;
    }
    // Omitted trailing fields are missing values, never shifted into another column.
    while (cells.length < expected.length) cells.push("");
    const id = cells[0].trim();
    if (!/^\d{1,30}$/.test(id) || table.has(id)) invalid(`${file} line ${line}: missing, invalid or duplicate source ID`);
    table.set(id, Object.fromEntries(expected.map((column, index) => [column, cells[index].trim()])));
    if (table.size > CDCI_LIMITS.rows) invalid(`${file}: too many source rows`);
  }
  if (!table.size) invalid(`${file}: no source records`);
  return table;
}

/** Read-only archive inspection. Paths are never extracted, and source text is never executed. */
export function readCdciPackage(bytes: Uint8Array): CdciPackage {
  if (!bytes.length || bytes.length > CDCI_LIMITS.compressedBytes) invalid("CDCI archive exceeds the 32 MB input limit");
  let entries: Record<string, Uint8Array>, count = 0, expanded = 0;
  try {
    entries = unzipSync(bytes, { filter: entry => {
      if (++count > CDCI_LIMITS.entries || /(^|\/)\.\.(\/|$)|\\/.test(entry.name) || entry.name.startsWith("/")) invalid("Unsafe CDCI archive paths or entry count");
      expanded += entry.originalSize;
      if (!Number.isSafeInteger(expanded) || expanded > CDCI_LIMITS.expandedBytes || entry.originalSize > CDCI_LIMITS.fileBytes) invalid("CDCI decompressed contents exceed their safe size limit");
      return Object.hasOwn(columns, entry.name.split("/").at(-1)!) || entry.name.endsWith("/License.txt") || entry.name === "License.txt";
    } });
  } catch (error) { return invalid(error instanceof CommandError ? error.message : "Invalid or unsupported CDCI ZIP"); }
  const files = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(entries)) {
    const name = path.split("/").at(-1)!;
    if (files.has(name)) invalid(`Duplicate ${name} in CDCI archive`);
    files.set(name, content);
  }
  const licenceBytes = files.get("License.txt");
  if (!licenceBytes || licenceBytes.length > 50000) invalid("Retain the actual CDCI License.txt in the package");
  const licence = decode(licenceBytes!);
  if (!licence.includes("Common Drug Codes for India") || !licence.includes("C-DAC")) invalid("CDCI source licence could not be identified");
  const tables = {} as CdciPackage["tables"], fileHashes: Record<string, string> = {};
  let newestRecordDate = "";
  for (const file of Object.keys(columns) as Master[]) {
    const content = files.get(file); if (!content) invalid(`Missing CDCI ${file}`);
    tables[file] = parseMaster(file, content!); fileHashes[file] = sha(content!);
    for (const row of tables[file].values()) if (/^\d{8}$/.test(row.last_updated_on || "") && row.last_updated_on > newestRecordDate) newestRecordDate = row.last_updated_on;
  }
  return { tables, licence, fileHashes, packageSha256: sha(bytes), licenceSha256: sha(licenceBytes!), newestRecordDate };
}
function codes(value: string, label: string) {
  if (!value) return [];
  const ids = value.split("+");
  if (ids.length > 100 || ids.some(id => !/^\d{1,30}$/.test(id.trim()))) invalid(`Unrecognized ${label} reference expression; confirm source relationships`);
  return [...new Set(ids.map(id => id.trim()))];
}
function joined(table: Map<string, Row>, ids: string[], field: string, label: string) {
  return ids.map(id => { const row = table.get(id); if (!row || !row[field]) return invalid(`Missing ${label} reference ${id}`); return row[field]; });
}
/** Exact foreign-key joins only: no fuzzy matching, strength/pack guessing or clinical approval. */
export function mapCdciBrand(packageData: CdciPackage, brand: Row) {
  const generic = packageData.tables["GenericMaster.txt"].get(brand["Generic Identifier"]);
  const supplier = packageData.tables["SupplierMaster.txt"].get(brand["Supplier Identifier"]);
  const product = packageData.tables["ProductMaster.txt"].get(brand["Product Identifier"]);
  if (!generic || !supplier || !product) return invalid("Brand product, supplier or generic reference is missing");
  const substances = codes(generic["Substance Identifier"], "substance"), dosageForms = codes(generic["Dose Form"], "dose form"), routes = codes(generic["Route of Administration"], "route");
  const composition = joined(packageData.tables["SubstanceMaster.txt"], substances, "Substance Name", "substance").join(" + ");
  const dosageForm = joined(packageData.tables["DrugFormMaster.txt"], dosageForms, "Dose Form", "dose form").join(" + ");
  joined(packageData.tables["RouteOfAdministrationMaster.txt"], routes, "RouteOfAdministration", "route");
  const row = { sourceId: brand.Identifier, name: brand["Brand Name"], genericName: generic["Generic Name"], composition, dosageForm,
    supplierName: supplier["Supplier Name"], sourceUpdatedOn: brand.last_updated_on || "",
    sourceIds: { product: brand["Product Identifier"], generic: brand["Generic Identifier"], supplier: brand["Supplier Identifier"], substances, dosageForms, routes },
    // This package has no verified physical pack size, barcode, manufacturer-role flag or prices.
    manufacturer: "", strength: "", packSize: "", barcodes: [] };
  normalizeGlobalProduct(row); // Enforce the same clinical identity limits as adoption, without truncation.
  return row;
}
export interface CdciReview { mappingVersion: string; packageSha256: string; licenceSha256: string; fileHashes: Record<string, string>; newestRecordDate: string;
  masters: Record<string, number>; totalBrands: number; importable: number; rejected: number; rejectionReasons: Record<string, number>; rejectedSamples: Array<{ sourceId: string; reason: string }>;
  rejectedSourceIds: string[];
  missingFields: string[]; databaseChanged: false }
export function inspectCdciPackage(data: CdciPackage): CdciReview {
  let importable = 0, rejected = 0;
  const rejectionReasons: Record<string, number> = {}, rejectedSamples: CdciReview["rejectedSamples"] = [], rejectedSourceIds: string[] = [];
  for (const brand of data.tables["BrandMaster.txt"].values()) {
    try { mapCdciBrand(data, brand); importable++; }
    catch (error) {
      if (!(error instanceof CommandError)) throw error;
      rejected++; rejectedSourceIds.push(brand.Identifier);
      const reason = error.message.replace(/\b\d{6,30}\b/g, "[source ID]");
      rejectionReasons[reason] = (rejectionReasons[reason] || 0) + 1;
      if (rejectedSamples.length < 50) rejectedSamples.push({ sourceId: brand.Identifier, reason: error.message });
    }
  }
  return { mappingVersion: CDCI_MAPPING_VERSION, packageSha256: data.packageSha256, licenceSha256: data.licenceSha256, fileHashes: data.fileHashes, newestRecordDate: data.newestRecordDate,
    masters: Object.fromEntries(Object.entries(data.tables).map(([file, table]) => [file, table.size])), totalBrands: data.tables["BrandMaster.txt"].size,
    importable, rejected, rejectionReasons, rejectedSamples, rejectedSourceIds, missingFields: ["physical pack conversion", "barcode", "verified manufacturer role", "branch prices", "stock", "batches", "expiry", "dispensing and tax approval"], databaseChanged: false };
}

import mongoose from "mongoose";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Medicine } from "../models/Medicine.ts";
import { medicineSearchFields, medicineSearchValue } from "../utilities/medicineSearchIndex.ts";
import { inspectDatabaseIndexes } from "../services/DatabaseIndexService.ts";

export function medicineSearchPreparationMode(args: string[]) {
  const location = args.find(arg => arg.startsWith("--location="));
  if (new Set(args).size !== args.length || args.some(arg => !["--help", "--check", "--apply", "--writes-paused"].includes(arg) && arg !== location) || location && !/^--location=[a-f\d]{24}$/i.test(location) ||
    args.includes("--check") && args.includes("--apply") || args.includes("--help") && args.length > 1 || args.includes("--writes-paused") && !args.includes("--apply") || args.includes("--apply") && !args.includes("--writes-paused")) throw Error("Use --help; writes require --apply --writes-paused.");
  const mode = args.includes("--help") ? "help" : args.includes("--apply") ? "apply" : args.includes("--check") ? "check" : "preview";
  return { mode, locationId: location?.slice("--location=".length) };
}

/** Read-only by default. Only derived search fields change in explicit paused-write apply mode.
 * Every repair also matches the source identity, so a concurrent edit cannot publish stale keys.
 */
export async function inspectMedicineSearch(apply = false, locationId?: string) {
  let after: mongoose.Types.ObjectId | undefined, scanned = 0, stale = 0, repaired = 0, conflicts = 0;
  while (true) {
    const page = await Medicine.find({ deletedAt: null, ...(locationId ? { locationId } : {}), ...(after ? { _id: { $gt: after } } : {}) })
      .select("name genericName strength manufacturer +searchIndex").sort({ _id: 1 }).limit(200).maxTimeMS(5000).lean();
    for (const row of page) {
      scanned++;
      const projection = Object.fromEntries(medicineSearchFields.map(field => [field, medicineSearchValue(row[field])]));
      if (JSON.stringify(row.searchIndex) === JSON.stringify(projection)) continue;
      stale++;
      if (!apply) continue;
      const result = await Medicine.collection.updateOne({ _id: row._id, deletedAt: null, ...Object.fromEntries(medicineSearchFields.map(field => [field, row[field] ?? null])) }, { $set: { searchIndex: projection } });
      if (result.matchedCount) repaired++; else conflicts++;
    }
    if (page.length < 200) break;
    after = page.at(-1)!._id;
  }
  return { scanned, stale, repaired, conflicts, ready: apply ? stale === repaired && conflicts === 0 : stale === 0 };
}

export async function runMedicineSearchPreparation(args = process.argv.slice(2)) {
  const { mode, locationId } = medicineSearchPreparationMode(args);
  if (mode === "help") { console.log("Default: disconnected preview. --check: read-only indexes/projection readiness. --apply --writes-paused: refresh derived keys for the current development catalogue. Optional --location=<24-hex-ID>. Connected modes use the operator-selected MONGODB_URI. No product identity, prices, stock, authority, documents or indexes are changed. Prepare schema indexes separately with db:indexes."); return; }
  if (mode === "preview") { console.log(JSON.stringify({ version: 1, mode, fields: medicineSearchFields, indexes: Medicine.schema.indexes().filter(([, options]) => String(options.name).startsWith("pharmacy_search_")), connected: false })); return; }
  if (!process.env.MONGODB_URI) throw Error("Select MONGODB_URI before a connected check or apply.");
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    const indexes = await inspectDatabaseIndexes([Medicine]), projection = await inspectMedicineSearch(mode === "apply", locationId);
    console.log(JSON.stringify({ version: 1, mode, scope: locationId ? "selected_branch" : "selected_database", indexesReady: indexes.ready, projection, ready: indexes.ready && projection.ready }));
    if (!indexes.ready || !projection.ready) process.exitCode = 2;
  } finally { await mongoose.disconnect(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runMedicineSearchPreparation().catch(() => {
  console.error("Medicine search preparation failed. Check arguments, selected configuration and database permissions. Connection and record details are omitted."); process.exitCode = 1;
});

import mongoose from "mongoose";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { reviewCatalogueBatch, ingestReviewedCatalogue } from "../services/PharmacyCatalogueIngestionService.ts";
import { reviewCatalogueMaintenance, maintainReviewedCatalogue } from "../services/PharmacyCatalogueMaintenanceService.ts";

/** Generic canonical batches. The verified CDCI seven-master ZIP adapter is
 * scripts/import-pharmacy-cdci.ts; all loaders share the same rights/write boundary. */
export async function runCatalogueImport(args = process.argv.slice(2)) {
  if (!args.length || args.includes("--help")) { console.log("Usage: node --env-file=.env scripts/import-pharmacy-catalogue.ts <mapped-batch.json> [--maintenance] [--apply --actor=<root-id>]. Default is disconnected validation. --maintenance reviews one exact reference availability action instead of an ingestion batch. Maximum 200 products / 512,000 bytes. Retain source licence, mapping and rights review evidence. Prepare database indexes separately before apply."); return; }
  const [file, ...flags] = args;
  if (flags.some(flag => !["--apply", "--maintenance"].includes(flag) && !/^--actor=[a-f\d]{24}$/i.test(flag)) || new Set(flags).size !== flags.length || flags.filter(flag => flag.startsWith("--actor=")).length > 1) throw new Error("Invalid import arguments");
  if ((await stat(file)).size > 512000) throw new Error("Split the reviewed mapping into batches of at most 512,000 bytes");
  const bytes = await readFile(file), raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (flags.includes("--maintenance")) reviewCatalogueMaintenance(raw);
  const batch = flags.includes("--maintenance") ? null : reviewCatalogueBatch(raw);
  if (!flags.includes("--apply")) { console.log(JSON.stringify({ preview: true, ...(batch ? { provider: batch.provider, release: batch.release, products: batch.products.length } : { maintenance: reviewCatalogueMaintenance(raw) }), databaseChanged: false })); return; }
  const actor = flags.find(flag => flag.startsWith("--actor="))?.slice(8);
  if (!actor || !process.env.MONGODB_URI) throw new Error("Apply requires a root actor and operator-selected MONGODB_URI");
  try {
    await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false, autoCreate: false });
    const indexes = await mongoose.models.PharmacyGlobalProduct!.collection.listIndexes().toArray();
    if (!indexes.some(index => index.name === "pharmacy_global_source" && index.unique)) throw new Error("Prepare catalogue indexes before ingestion");
    console.log(JSON.stringify(flags.includes("--maintenance") ? await maintainReviewedCatalogue(raw, actor) : await ingestReviewedCatalogue(raw, actor, createHash("sha256").update(bytes).digest("hex"))));
  } finally { await mongoose.disconnect(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCatalogueImport().catch(error => { console.error(error instanceof Error ? error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[database address omitted]") : "Catalogue ingestion failed"); process.exitCode = 1; });

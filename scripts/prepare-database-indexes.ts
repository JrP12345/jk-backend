import mongoose from "mongoose";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { currentSchemaIndexManifest, inspectDatabaseIndexes, prepareDatabaseIndexes, DatabaseIndexSetupError } from "../services/DatabaseIndexService.ts";

export function databaseIndexMode(input: string[]): "help" | "preview" | "check" | "apply" {
  const args = new Set(input);
  if (input.length !== args.size || input.some(arg => !["--help", "--check", "--apply", "--writes-paused"].includes(arg)) ||
      args.has("--check") && args.has("--apply") || args.has("--writes-paused") && !args.has("--apply") || args.has("--help") && args.size > 1) throw new DatabaseIndexSetupError("Unsupported index-preparation arguments. Use --help.");
  if (args.has("--apply") && !args.has("--writes-paused")) throw new DatabaseIndexSetupError("Index creation requires explicit --apply --writes-paused.");
  return args.has("--help") ? "help" : args.has("--apply") ? "apply" : args.has("--check") ? "check" : "preview";
}

/** Schema preview is disconnected; check is metadata-only; setup never removes data/indexes. */
export async function runDatabaseIndexSetup(args = process.argv.slice(2)) {
  const mode = databaseIndexMode(args);
  if (mode === "help") { console.log("Default: disconnected schema preview. --check: read-only readiness. --apply --writes-paused: explicit collection/index setup. Connected modes use the operator-selected MONGODB_URI; no records or indexes are removed."); return; }
  mongoose.set("autoIndex", false); mongoose.set("autoCreate", false);
  const directory = new URL("../models/", import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith(".ts")).sort()) {
    await import(new URL(file, directory).href);
  }
  const models = Object.values(mongoose.models);
  if (mode === "preview") {
    for (const model of currentSchemaIndexManifest(models)) console.log(JSON.stringify(model));
    console.log("Preview only. No database connection or index changes were made.");
    return;
  }
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new DatabaseIndexSetupError("MONGODB_URI is required for the operator-selected connected check/setup.");
  try {
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    const transactionCapable = Boolean(hello.setName || hello.msg === "isdbgrid");
    if (mode === "apply" && !transactionCapable) throw new DatabaseIndexSetupError("Pharmacy setup requires a transaction-capable MongoDB replica set or managed cluster. No setup was applied.");
    const report = mode === "apply" ? await prepareDatabaseIndexes(models) : await inspectDatabaseIndexes(models);
    console.log(JSON.stringify({ version: 1, mode, transactionCapable, ...report, ready: report.ready && transactionCapable }));
    if (!report.ready || !transactionCapable) process.exitCode = 2;
  } finally { await mongoose.disconnect(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runDatabaseIndexSetup().catch(error => {
  console.error(error instanceof DatabaseIndexSetupError ? error.message : "Database index setup failed. Check selected configuration and metadata permissions; connection and record details are omitted.");
  if (error instanceof DatabaseIndexSetupError && error.report) console.error(JSON.stringify(error.report));
  process.exitCode = 1;
});

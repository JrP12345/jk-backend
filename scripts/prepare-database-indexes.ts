import mongoose from "mongoose";
import { readdir } from "node:fs/promises";

/** Preview current schema indexes; apply only during an explicit maintenance window. */
async function prepareDatabaseIndexes() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  const args = new Set(process.argv.slice(2));
  if (args.has("--apply") && !args.has("--writes-paused")) throw new Error("Index creation requires --writes-paused");
  const directory = new URL("../models/", import.meta.url);
  for (const file of (await readdir(directory)).filter(file => file.endsWith(".ts")).sort()) {
    await import(new URL(file, directory).href);
  }
  if (!args.has("--apply")) {
    for (const model of Object.values(mongoose.models)) console.log(JSON.stringify({ model: model.modelName, indexes: model.schema.indexes() }));
    console.log("Preview only. No database connection or index changes were made.");
    return;
  }
  try {
    await mongoose.connect(uri, { autoIndex: false });
    for (const model of Object.values(mongoose.models)) await model.createIndexes();
    console.log("Current schema indexes prepared. No records or existing indexes were removed.");
  } finally { await mongoose.disconnect(); }
}
prepareDatabaseIndexes().catch(error => { console.error(error.message); process.exitCode = 1; });

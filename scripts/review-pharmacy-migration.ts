import mongoose from "mongoose";
import { pathToFileURL } from "node:url";
import { PHARMACY_REVIEW_SECTIONS, reviewPharmacyMigrationPage, validatePharmacyReviewInput, type PharmacyReviewInput, type PharmacyReviewSection } from "../services/PharmacyMigrationReviewService.ts";

/** No --apply option, no default application connection, no model/index registration. */
export function parsePharmacyReviewArguments(args: string[]): PharmacyReviewInput {
  const keys = new Set(["--organization", "--location", "--snapshot-id", "--as-of", "--section", "--cursor", "--limit"]);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    if (!keys.has(args[index]) || !args[index + 1] || args[index + 1].startsWith("--") || values.has(args[index])) throw new Error("Only explicit read-only review arguments are supported");
    values.set(args[index], args[index + 1]);
  }
  for (const key of ["--organization", "--location", "--snapshot-id", "--as-of", "--section"]) if (!values.has(key)) throw new Error("Organization, location, snapshot ID, as-of and section are required");
  if (!PHARMACY_REVIEW_SECTIONS.includes(values.get("--section") as PharmacyReviewSection)) throw new Error("Unknown review section");
  const input = { organizationId: values.get("--organization")!, locationId: values.get("--location")!, snapshotId: values.get("--snapshot-id")!, asOf: values.get("--as-of")!,
    section: values.get("--section") as PharmacyReviewSection, ...(values.has("--cursor") ? { cursor: values.get("--cursor") } : {}),
    ...(values.has("--limit") ? { limit: Number(values.get("--limit")) } : {}) };
  validatePharmacyReviewInput(input);
  return input;
}
async function main() {
  const input = parsePharmacyReviewArguments(process.argv.slice(2));
  const uri = process.env.PHARMACY_REVIEW_MONGODB_URI;
  if (!uri) throw new Error("A dedicated read-only snapshot connection is required");
  try {
    await mongoose.connect(uri, { autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 8000 });
    console.log(JSON.stringify(await reviewPharmacyMigrationPage(input), null, 2));
  } finally { await mongoose.disconnect(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Pharmacy review failed. Check the scope, snapshot connection and arguments. Connection details are not logged; no apply mode exists."); process.exitCode = 1; });
}

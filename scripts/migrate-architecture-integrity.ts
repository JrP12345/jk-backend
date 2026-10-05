import mongoose from "mongoose";
import { Invoice } from "../models/Invoice.ts";
import { OperationReceipt } from "../models/OperationReceipt.ts";
import { AuditChainHead } from "../models/AuditChainHead.ts";
import { AIPromptTemplate } from "../models/AIPromptTemplate.ts";
import { UploadIntent } from "../models/UploadIntent.ts";
import { Counter } from "../models/Counter.ts";

// Read-only by default. Never delete duplicate financial or clinical authority.
async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  const args = new Set(process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI, { autoIndex: false });
  const checks = [
    { model: Invoice, match: { generationKey: { $type: "string" } }, key: "$generationKey" },
    { model: Invoice, match: { encounterId: { $type: "objectId" }, deletedAt: null, status: { $nin: ["cancelled", "refunded"] } }, key: "$encounterId" },
    { model: AIPromptTemplate, match: { status: "active" }, key: { key: "$key", organizationId: "$organizationId" } },
  ];
  let conflicts = 0;
  for (const check of checks) {
    const groups = await check.model.aggregate([{ $match: check.match }, { $group: { _id: check.key, count: { $sum: 1 } } }, { $match: { count: { $gt: 1 } } }, { $limit: 100 }]).option({ maxTimeMS: 10_000 });
    conflicts += groups.length;
    console.log(JSON.stringify({ collection: check.model.collection.name, duplicateGroups: groups.length, cappedAt: 100 }));
  }
  const indexes = await UploadIntent.collection.indexes().catch((error: any) => { if (error.code === 26) return []; throw error; });
  const ttl = indexes.filter(index => index.expireAfterSeconds !== undefined && index.key.expiresAt !== undefined);
  console.log(JSON.stringify({ unfinishedUploadTTLIndexes: ttl.map(index => index.name) }));
  if (conflicts) throw new Error("Resolve duplicate authority manually before applying indexes; no records were deleted");
  if (!args.has("--apply")) { console.log("Preflight complete. No indexes or data changed."); return; }
  if (!args.has("--writes-paused") || !args.has("--upload-cleanup-deployed")) throw new Error("Apply requires --writes-paused --upload-cleanup-deployed and a reviewed recovery/rollback plan");
  await OperationReceipt.createIndexes();
  await Counter.createIndexes();
  await AuditChainHead.createIndexes();
  await Invoice.createIndexes();
  await AIPromptTemplate.createIndexes();
  await UploadIntent.createIndexes();
  // Metadata must survive until storage deletion succeeds in the cleanup worker.
  for (const index of ttl) await UploadIntent.collection.dropIndex(index.name!);
  console.log("Integrity indexes applied. Verify worker readiness and critical journeys before reopening writes.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());

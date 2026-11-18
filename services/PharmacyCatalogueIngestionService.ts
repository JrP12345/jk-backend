import { PharmacyGlobalProduct } from "../models/PharmacyGlobalProduct.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { User } from "../models/User.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { catalogueProviders, normalizeGlobalProduct } from "../utilities/pharmacyGlobalCatalogue.ts";
import { identifier, object, text } from "../schemas/pharmacyPurchases.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import type { AnyBulkWriteOperation } from "mongoose";

/** Operator-only batch loader. No tenant can publish another tenant's catalogue globally.
 * Rights evidence is a human/legal review, never inferred from a public download URL.
 */
export function reviewCatalogueBatch(raw: unknown) {
  const input = object(raw, ["provider", "release", "reference", "licenceSha256", "reviewReference", "commercialStorageAndRedistributionApproved", "products", "snomedAffiliateReference", "indiaDeploymentAndUsersConfirmed"]);
  if (!catalogueProviders.includes(input.provider)) throw new CommandError(400, "Unknown catalogue provider");
  if (input.commercialStorageAndRedistributionApproved !== true) throw new CommandError(400, "Explicit review of commercial storage and shared-catalogue redistribution rights is required");
  if (typeof input.licenceSha256 !== "string" || !/^[a-f\d]{64}$/.test(input.licenceSha256)) throw new CommandError(400, "Retain the actual source licence and provide its SHA-256");
  const snomedAffiliateReference = input.provider === "cdci" ? text(input.snomedAffiliateReference, "actual SNOMED affiliate or written NRCeS permission reference", 3, 200) : "";
  if (input.provider === "cdci" && input.indiaDeploymentAndUsersConfirmed !== true) throw new CommandError(403, "CDCI requires reviewed India-only deployment and user scope");
  if (!Array.isArray(input.products) || !input.products.length || input.products.length > 200) throw new CommandError(400, "Review 1 to 200 mapped products per batch");
  const products = input.products.map(normalizeGlobalProduct);
  if (new Set(products.map(row => row.sourceId)).size !== products.length) throw new CommandError(400, "Duplicate external source IDs in this batch");
  return { provider: input.provider as typeof catalogueProviders[number], release: text(input.release, "source release", 1, 200),
    reference: text(input.reference, "source reference", 3, 500), licenceSha256: input.licenceSha256 as string,
    reviewReference: text(input.reviewReference, "rights review reference", 3, 500), snomedAffiliateReference, products };
}

export async function ingestReviewedCatalogue(raw: unknown, actorId: string, fileSha256: string) {
  const input = reviewCatalogueBatch(raw);
  if (!/^[a-f\d]{64}$/.test(fileSha256)) throw new CommandError(400, "Actual source file SHA-256 required");
  const actor = identifier(actorId);
  if (!await User.exists({ _id: actor, role: "root", deletedAt: null, isActive: { $ne: false } })) throw new CommandError(403, "An active root operator is required for shared catalogue ingestion");
  return withTransaction(async session => {
    requireStockTransaction(session);
    // A single operator fence serializes providers/releases without a second registry collection.
    const lock = await User.updateOne({ _id: actor, role: "root", deletedAt: null, isActive: { $ne: false } }, { $inc: { __v: 1 } }, { session });
    if (lock.matchedCount !== 1) throw new CommandError(403, "Root operator is no longer active");
    let created = 0, updated = 0, unchanged = 0;
    const current = await PharmacyGlobalProduct.find({ provider: input.provider, sourceId: { $in: input.products.map(product => product.sourceId) } }).session(session).lean();
    const bySource = new Map(current.map(product => [product.sourceId, product]));
    const writes: AnyBulkWriteOperation[] = [];
    for (const product of input.products) {
      const existing = bySource.get(product.sourceId);
      if (existing?.source?.rowSha256 === product.rowSha256 && existing.source.release === input.release && existing.source.licenceSha256 === input.licenceSha256 && existing.source.reviewReference === input.reviewReference &&
          (existing.source.snomedAffiliateReference || "") === input.snomedAffiliateReference && existing.active) { unchanged++; continue; }
      const { rowSha256, ...identity } = product;
      const source = { release: input.release, reference: input.reference, licenceSha256: input.licenceSha256, reviewReference: input.reviewReference,
        ...(input.provider === "cdci" ? { snomedAffiliateReference: input.snomedAffiliateReference, territory: "IN" } : {}), fileSha256, rowSha256, importedAt: new Date() };
      if (existing) {
        if (!Number.isSafeInteger(existing.revision + 1)) throw new CommandError(409, "Source revision requires operator review");
        writes.push({ updateOne: { filter: { _id: existing._id, revision: existing.revision }, update: { $set: { ...identity, source, active: true }, $inc: { revision: 1 } } } }); updated++;
      } else {
        writes.push({ insertOne: { document: { ...identity, provider: input.provider, source, revision: 1, active: true } } }); created++;
      }
    }
    if (writes.length) {
      const written = await PharmacyGlobalProduct.bulkWrite(writes, { session, ordered: true });
      if (written.insertedCount !== created || written.matchedCount !== updated) throw new CommandError(409, "Catalogue changed during ingestion; rerun this same reviewed batch");
    }
    await createWithSession(AuditLog, { organizationId: null, userId: actor, action: "PHARMACY_GLOBAL_CATALOGUE_IMPORTED", category: "ADMIN", targetModel: "PharmacyGlobalProduct",
      details: { provider: input.provider, release: input.release, reference: input.reference, licenceSha256: input.licenceSha256,
        reviewReference: input.reviewReference, ...(input.provider === "cdci" ? { snomedAffiliateReference: input.snomedAffiliateReference, territory: "IN" } : {}), fileSha256, sourceRows: input.products.map(row => ({ sourceId: row.sourceId, rowSha256: row.rowSha256 })), created, updated, unchanged } }, session);
    return { created, updated, unchanged };
  }, { writeConcern: { w: "majority" } });
}

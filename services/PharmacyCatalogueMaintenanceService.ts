import { PharmacyGlobalProduct } from "../models/PharmacyGlobalProduct.ts";
import { User } from "../models/User.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { identifier, object, text, whole } from "../schemas/pharmacyPurchases.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { createWithSession, withTransaction } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";

export function reviewCatalogueMaintenance(raw: unknown) {
  const input = object(raw, ["productId", "expectedRevision", "status", "reason", "reviewReference", "confirmed"]);
  if (input.confirmed !== true || !["available", "withdrawn", "discontinued"].includes(input.status)) throw new CommandError(400, "Confirm the exact catalogue availability action");
  const reason = text(input.reason, "reason", 3, 500), reviewReference = text(input.reviewReference, "review reference", 3, 500);
  if (/[\p{Cc}\p{Cf}]/u.test(reason + reviewReference)) throw new CommandError(400, "Use plain text for review evidence");
  return { productId: identifier(input.productId), expectedRevision: whole(input.expectedRevision, "catalogue revision", Number.MAX_SAFE_INTEGER - 1),
    status: input.status as "available" | "withdrawn" | "discontinued", reason, reviewReference };
}

/** Explicit operator review, never inferred from an absent row or fuzzy name.
 * Existing branch products, prices, batches, stock and sale holds are untouched. */
export async function maintainReviewedCatalogue(raw: unknown, actorId: string) {
  const input = reviewCatalogueMaintenance(raw), actor = identifier(actorId);
  return withTransaction(async session => {
    requireStockTransaction(session);
    const lock = await User.updateOne({ _id: actor, role: "root", deletedAt: null, isActive: { $ne: false } }, { $inc: { __v: 1 } }, { session });
    if (lock.matchedCount !== 1) throw new CommandError(403, "An active root operator is required for shared catalogue maintenance");
    const changedAt = new Date();
    const row = await PharmacyGlobalProduct.findOneAndUpdate({ _id: input.productId, revision: input.expectedRevision }, {
      $set: { maintenance: { status: input.status, reason: input.reason, reviewReference: input.reviewReference, changedAt, changedBy: actor } }, $inc: { revision: 1 },
    }, { session, returnDocument: "after", runValidators: true });
    if (!row) throw new CommandError(409, "Catalogue reference changed; review its current revision before retrying");
    await createWithSession(AuditLog, { organizationId: null, userId: actor, action: "PHARMACY_GLOBAL_CATALOGUE_MAINTAINED", category: "ADMIN", targetModel: "PharmacyGlobalProduct", targetId: row._id,
      details: { provider: row.provider, sourceId: row.sourceId, previousRevision: input.expectedRevision, revision: row.revision, status: input.status, reason: input.reason, reviewReference: input.reviewReference } }, session);
    return { id: String(row._id), revision: row.revision, maintenance: row.maintenance };
  }, { writeConcern: { w: "majority" } });
}

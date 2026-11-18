import type { FastifyRequest } from "fastify";
import { Medicine } from "../models/Medicine.ts";
import { MedicineBatch } from "../models/MedicineBatch.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { PharmacyOfflineSnapshotPage } from "../models/PharmacyOfflineSnapshotPage.ts";
import { identifier, object, text, whole } from "../schemas/pharmacyPurchases.ts";
import { withTransaction, createWithSession } from "../utilities/transaction.ts";
import { requireStockTransaction } from "../utilities/pharmacyInventory.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { CommandError } from "./CommandReceiptService.ts";

export async function readMedicineSaleControls(req: FastifyRequest, id: string) {
  const query = object(req.query, ["locationId", "cursor", "organizationId", "organization_id"]), scope = await purchaseScope(req, query.locationId);
  const medicine = await Medicine.findOne({ _id: identifier(id), locationId: scope.locationId, deletedAt: null }).select("name saleControl").lean();
  if (!medicine) throw new CommandError(404, "Product not found at this branch");
  const lots = await MedicineBatch.find({ medicineId: medicine._id, locationId: scope.locationId, organizationId: scope.organizationId,
    ...(query.cursor ? { _id: { $gt: identifier(query.cursor) } } : {}) }).select("batchNumber expiryDate status saleControl").sort({ _id: 1 }).limit(26).maxTimeMS(5000).lean();
  return { medicineId: id, locationId: scope.locationId, name: medicine.name, saleControl: medicine.saleControl || null,
    batches: lots.slice(0, 25).map(lot => ({ id: String(lot._id), batchNumber: lot.batchNumber, expiryDate: lot.expiryDate, status: lot.status, saleControl: lot.saleControl || null })),
    nextCursor: lots.length > 25 ? String(lots[24]._id) : null };
}

export async function savePharmacySaleControl(req: FastifyRequest, id: string, kind: "product" | "batch") {
  const input = object(req.body, ["locationId", "expectedRevision", "blocked", "reason", "reviewReference", "confirmed", "organizationId", "organization_id"]);
  const scope = await purchaseScope(req, input.locationId), targetId = identifier(id), expectedRevision = whole(input.expectedRevision, "sale-control revision", Number.MAX_SAFE_INTEGER - 1);
  if (typeof input.blocked !== "boolean" || input.confirmed !== true) throw new CommandError(400, "Confirm the exact product/batch and the sale-control action");
  const reason = text(input.reason, "reason", 3, 500), reviewReference = text(input.reviewReference, "review reference", 3, 200);
  if (/[\p{Cc}\p{Cf}]/u.test(reason + reviewReference)) throw new CommandError(400, "Use plain text for sale-control evidence");
  return withTransaction(async session => {
    requireStockTransaction(session);
    const now = new Date();
    // Blocking is allowed even during exclusive offline ownership: safety controls
    // change no stock. Releasing is forbidden until that original PC reconciles.
    const branch = await Location.findOneAndUpdate({ _id: scope.locationId, organizationId: scope.organizationId,
      ...(!input.blocked ? { pharmacyOfflineOwner: { $exists: false } } : {}) },
    { $set: { pharmacySaleControlUpdatedAt: now }, $inc: { __v: 1 } }, { session, returnDocument: "after", timestamps: false });
    if (!branch) throw new CommandError(409, "Reconcile and close the original offline billing session before releasing a sale hold");
    const lot = kind === "batch" ? await MedicineBatch.findOne({ _id: targetId, locationId: scope.locationId, organizationId: scope.organizationId }).session(session) : null;
    if (kind === "batch" && !lot) throw new CommandError(404, "Batch not found at this branch");
    const medicine = await Medicine.findOne({ _id: lot?.medicineId || targetId, locationId: scope.locationId, deletedAt: null }).session(session);
    if (!medicine) throw new CommandError(404, "Product not found at this branch");
    const current = lot?.saleControl || (kind === "product" ? medicine.saleControl : undefined);
    if ((current?.revision || 0) !== expectedRevision) throw new CommandError(409, "Sale control changed; reload its current result before retrying");
    const control = { revision: expectedRevision + 1, blocked: input.blocked, reason, reviewReference, changedAt: now, changedBy: scope.actorId,
      ...(input.blocked ? { blockedAt: current?.blocked && current.blockedAt ? current.blockedAt : now } : {}) };
    const target = lot || medicine;
    target.set("saleControl", control); await target.save({ session });
    // Serializes a batch hold with clinical and billing-only product writes as well.
    if (lot) await Medicine.updateOne({ _id: medicine._id, locationId: scope.locationId }, { $inc: { __v: 1 } }, { session, timestamps: false });
    await createWithSession(AuditLog, { organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_SALE_CONTROL_CHANGED", category: "ADMIN",
      targetModel: lot ? "MedicineBatch" : "Medicine", targetId: target._id,
      details: { locationId: scope.locationId, medicineId: String(medicine._id), blocked: input.blocked, revision: control.revision, reason, reviewReference } }, session);
    return { id: String(target._id), medicineId: String(medicine._id), locationId: scope.locationId, saleControl: control,
      offlineNotice: branch.pharmacyOfflineOwner ? "An offline PC owns this branch. Contact its operator immediately. It will stop new issuance when the authenticated safety check reaches it; disconnected PCs cannot receive new holds." : null };
  }, { writeConcern: { w: "majority" } });
}

/** Authenticated stop signal, separate from immutable already-issued receipt import. */
export async function readOfflineSaleControlStatus(req: FastifyRequest, locationId: string, authorityId: string) {
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(authorityId)) throw new CommandError(400, "Invalid original offline authority");
  const scope = await purchaseScope(req, locationId);
  const authority = await PharmacyOfflineAuthority.findOne({ organizationId: scope.organizationId, locationId, authorityId }).select("state checkoutActivatedAt validUntil").lean();
  const manifest = await PharmacyOfflineSnapshotPage.findOne({ organizationId: scope.organizationId, locationId, authorityId, page: -1 }).select("payload sha256").lean();
  if (!authority || !manifest) throw new CommandError(404, "Original offline preparation is unavailable");
  const branch = await Location.findOne({ _id: locationId, organizationId: scope.organizationId }).select("pharmacyOfflineOwner pharmacySaleControlUpdatedAt").lean();
  const preparedAt = new Date(JSON.parse(manifest.payload).preparedAt), now = new Date();
  if (!Number.isFinite(preparedAt.getTime())) throw new CommandError(409, "Original offline preparation needs review");
  return { authorityId, manifestDigest: manifest.sha256, checkedAt: now.toISOString(), controlsUpdatedAt: branch?.pharmacySaleControlUpdatedAt?.toISOString() || null,
    continueIssuance: Boolean(branch?.pharmacyOfflineOwner === authorityId && authority.state === "held" && authority.checkoutActivatedAt && authority.validUntil > now &&
      (!branch.pharmacySaleControlUpdatedAt || branch.pharmacySaleControlUpdatedAt <= preparedAt)) };
}

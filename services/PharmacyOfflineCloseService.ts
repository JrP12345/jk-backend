import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { findOfflineDeviceEvidence } from "./PharmacyOfflineDeviceService.ts";
import { PharmacyOfflineImport } from "../models/PharmacyOfflineImport.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { offlineEvidenceCanonical } from "../utilities/pharmacyOfflineDocument.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { withVerifiedOfflineOwnership } from "../utilities/pharmacyOfflineOwnership.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { verifyOfflineDeviceMessage, requireOfflineImportIndexes } from "./PharmacyOfflineGrantService.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { object } from "../schemas/pharmacyPurchases.ts";

export interface OfflineStopCheckpoint {
  authorityId: string; sequence: number; lastDigest: string | null; stoppedAt: string;
  reviewReference: string; confirmed: true;
}
export function offlineStopMessage(scope: { organizationId: string; locationId: string; deviceId: string }, checkpoint: OfflineStopCheckpoint) {
  return `ekavyu.pharmacy.stopped-ledger.v1\n${offlineEvidenceCanonical(scope)}\n${offlineEvidenceCanonical(checkpoint)}`;
}
function checkpoint(value: unknown): OfflineStopCheckpoint & { proof: string } {
  const raw = object(value, ["authorityId", "sequence", "lastDigest", "stoppedAt", "reviewReference", "confirmed", "proof"]);
  if (!/^[a-f0-9-]{36}$/.test(raw.authorityId) || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0 ||
      raw.lastDigest !== null && !/^[a-f0-9]{64}$/.test(raw.lastDigest) || raw.confirmed !== true ||
      typeof raw.stoppedAt !== "string" || !Number.isFinite(Date.parse(raw.stoppedAt)) || new Date(raw.stoppedAt).toISOString() !== raw.stoppedAt ||
      typeof raw.reviewReference !== "string" || raw.reviewReference.trim().length < 3 || raw.reviewReference.length > 500 || /[\p{Cc}\p{Cf}]/u.test(raw.reviewReference) ||
      typeof raw.proof !== "string" || !/^[\w-]{86}$/.test(raw.proof)) throw new CommandError(400, "The original signed, stopped ledger is required");
  return { authorityId: raw.authorityId, sequence: raw.sequence, lastDigest: raw.lastDigest, stoppedAt: raw.stoppedAt, reviewReference: raw.reviewReference.trim(), confirmed: true, proof: raw.proof };
}

/** A normal close needs the original PC's durable terminal checkpoint. Expiry,
 * revocation and a manager's login are never evidence that it stopped issuing.
 */
export async function closeOfflineCheckout(req: FastifyRequest, locationId: string, value: unknown) {
  const scope = await purchaseScope(req, locationId), { proof, ...stop } = checkpoint(value);
  if (!await pharmacyRequestAllows(req, "manageSettings")) throw new CommandError(403, "Branch settings authority is required to reconcile offline billing");
  const requestHash = createHash("sha256").update(offlineEvidenceCanonical({ ...scope, stop, proof })).digest("hex");
  const evidenceHash = createHash("sha256").update(offlineEvidenceCanonical({ stop, proof })).digest("hex");
  await requireOfflineImportIndexes();
  return withTransaction(async session => {
    if (!session?.inTransaction()) throw new CommandError(503, "Offline reconciliation requires transactions");
    const row = await PharmacyOfflineAuthority.findOne({ organizationId: scope.organizationId, locationId, authorityId: stop.authorityId });
    if (!row) throw new CommandError(404, "Original offline ownership is not visible");
    if (row.state === "closed") {
      if (row.closeRequestHash !== requestHash && row.closeEvidenceHash !== evidenceHash) throw new CommandError(409, "This ownership was closed with different evidence");
      return { authorityId: row.authorityId, state: "closed" as const, sequence: row.closeSequence, reservedNumbersRetained: true as const };
    }
    const device = await findOfflineDeviceEvidence(scope.organizationId, locationId, row.deviceId, row.enrollmentId);
    if (!device || !row.checkoutActivatedAt) throw new CommandError(409, "The original activated PC evidence requires recovery");
    verifyOfflineDeviceMessage(device.publicKey, offlineStopMessage({ organizationId: scope.organizationId, locationId, deviceId: row.deviceId }, stop), proof);
    const latest = await PharmacyOfflineImport.findOne({ authorityId: row.authorityId, sequence: row.importedSequence }).lean();
    const count = await PharmacyOfflineImport.countDocuments({ authorityId: row.authorityId });
    if (stop.sequence !== row.importedSequence || stop.sequence < row.firstSequence - 1 || stop.sequence > row.lastSequence ||
        stop.lastDigest !== (latest?.digest ?? null) || count !== stop.sequence - row.firstSequence + 1 ||
        Date.parse(stop.stoppedAt) < row.checkoutActivatedAt.getTime() || Date.parse(stop.stoppedAt) > Date.now() + 60_000 ||
        latest && Date.parse(stop.stoppedAt) < latest.issuedAt.getTime()) throw new CommandError(409, "Synchronize every original receipt through the stopped checkpoint before releasing this branch");
    await withVerifiedOfflineOwnership({ ...scope, authorityId: row.authorityId, drawerId: String(row.drawerId) }, async () => {
      const drawer = await CashierShift.findOne({ _id: row.drawerId, organizationId: scope.organizationId, locationId, kind: "drawer", status: "active", pharmacyOfflineOwner: row.authorityId });
      if (!drawer) throw new CommandError(409, "The original owned drawer requires review");
      const released = await CashierShift.updateOne({ _id: drawer._id, locationId, kind: "drawer", revision: drawer.revision, pharmacyOfflineOwner: row.authorityId, status: "active" },
        { $unset: { pharmacyOfflineOwner: 1 }, $inc: { revision: 1, __v: 1 } }, { session, timestamps: false });
      if (released.modifiedCount !== 1) throw new CommandError(409, "Drawer changed; retry the original close");
    });
    const branch = await Location.updateOne({ _id: locationId, organizationId: scope.organizationId, pharmacyOfflineOwner: row.authorityId }, { $unset: { pharmacyOfflineOwner: 1 }, $inc: { __v: 1 } });
    if (branch.modifiedCount !== 1) throw new CommandError(409, "Branch ownership changed; retain the stopped ledger");
    const closed = await PharmacyOfflineAuthority.updateOne({ _id: row._id, revision: row.revision, state: "held", importedSequence: stop.sequence },
      { $set: { state: "closed", closedAt: new Date(), closeRequestHash: requestHash, closeEvidenceHash: evidenceHash, closeSequence: stop.sequence }, $inc: { revision: 1 } });
    if (closed.modifiedCount !== 1) throw new CommandError(409, "Receipt import changed during close; retry the original checkpoint");
    await AuditLog.create({ organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_OFFLINE_CHECKOUT_RECONCILED", category: "BILLING", targetModel: "PharmacyOfflineAuthority", targetId: row._id,
      details: { locationId, originalActorId: String(row.actorId), ...stop, reservedNumbersRetained: true, proof } });
    return { authorityId: row.authorityId, state: "closed" as const, sequence: stop.sequence, reservedNumbersRetained: true as const };
  }, { writeConcern: { w: "majority" } });
}

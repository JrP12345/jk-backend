import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { PharmacyOfflineGrant } from "../models/PharmacyOfflineGrant.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { PharmacyOfflineDevice } from "../models/PharmacyOfflineDevice.ts";
import { PharmacyOfflineSnapshotPage } from "../models/PharmacyOfflineSnapshotPage.ts";
import { PharmacyOfflineImport } from "../models/PharmacyOfflineImport.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { Invoice } from "../models/Invoice.ts";
import { User } from "../models/User.ts";
import { Location } from "../models/Location.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { withVerifiedOfflineOwnership } from "../utilities/pharmacyOfflineOwnership.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { SERVICE_PRIVATE_KEY } from "../utilities/keys.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { CommandError, commandHash } from "./CommandReceiptService.ts";
import { requirePharmacyDispenseIndexes } from "./PharmacyDispenseIndexes.ts";
import { offlineReservationSigningKey } from "./PharmacyOfflineDeviceService.ts";
import { PHARMACY_CALCULATION_ENGINE_SHA256 } from "./InvoiceCalculationService.ts";
import { PHARMACY_OFFLINE_DOCUMENT_SHA256 } from "../utilities/pharmacyOfflineDocumentVersion.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export interface OfflineActivationIntent { authorityId: string; expectedRevision: number; manifestDigest: string; reviewReference: string; requestedAt: string; confirmed: true }
export function offlineActivationIntent(value: OfflineActivationIntent): OfflineActivationIntent {
  if (!value || !UUID.test(value.authorityId) || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1 || !/^[a-f0-9]{64}$/.test(value.manifestDigest) ||
      value.confirmed !== true || typeof value.reviewReference !== "string" || value.reviewReference.trim().length < 3 || value.reviewReference.length > 500 || /[\p{Cc}\p{Cf}]/u.test(value.reviewReference) ||
      typeof value.requestedAt !== "string" || !Number.isFinite(Date.parse(value.requestedAt)) || new Date(value.requestedAt).toISOString() !== value.requestedAt) throw new CommandError(400, "Confirm the completely stored preparation, original PC and actual review");
  return { authorityId: value.authorityId, expectedRevision: value.expectedRevision, manifestDigest: value.manifestDigest, reviewReference: value.reviewReference.trim(), requestedAt: value.requestedAt, confirmed: true };
}
export function offlineActivationMessage(scope: { organizationId: string; locationId: string; actorId: string }, intent: OfflineActivationIntent) {
  return `ekavyu.pharmacy.checkout-activation.v1\n${JSON.stringify(scope)}\n${JSON.stringify(offlineActivationIntent(intent))}`;
}
export function verifyOfflineDeviceMessage(key: crypto.JsonWebKeyInput["key"], message: string, proof: string) {
  if (typeof proof !== "string" || !/^[\w-]{86}$/.test(proof) || !crypto.verify("sha256", Buffer.from(message),
    { key: crypto.createPublicKey({ key, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(proof, "base64url"))) throw new CommandError(403, "The enrolled PC must sign its original offline evidence");
}
export async function requireOfflineImportIndexes() {
  await requirePharmacyDispenseIndexes();
  for (const [model, fields] of [[PharmacyOfflineGrant, ["authorityId"]], [PharmacyOfflineImport, ["authorityId", "commandId"]], [PharmacyOfflineImport, ["authorityId", "sequence"]], [PharmacyOfflineImport, ["invoiceId"]]] as const) {
    let indexes;
    try { indexes = await model.collection.listIndexes().toArray(); } catch { throw new CommandError(503, "Prepare offline grant/import collections and unique indexes before activation"); }
    if (!indexes.some(index => index.unique && !index.sparse && !index.partialFilterExpression && Object.keys(index.key).length === fields.length && fields.every(field => index.key[field] === 1))) throw new CommandError(503, "Prepare offline grant/import unique indexes before activation");
  }
  let pages;
  try { pages = await PharmacyOfflineSnapshotPage.collection.listIndexes().toArray(); } catch { throw new CommandError(503, "Prepare bounded offline snapshot lookup before activation"); }
  if (!pages.some(index => index.key.authorityId === 1 && index.key.recordIds === 1 && Object.keys(index.key).length === 2)) throw new CommandError(503, "Prepare bounded offline snapshot lookup before activation");
}
export function presentOfflineGrant(row: { payload: string; sha256: string; signature: string; signingKeyId: string; signingPublicKey: unknown }) {
  return { payload: row.payload, sha256: row.sha256, signature: row.signature, signingKey: { id: row.signingKeyId, jwk: row.signingPublicKey } };
}
/** Internal activation. Public routes must remain absent until the complete
 * local Save/import/stop/recovery lifecycle has passed integration checks.
 */
export async function activateOfflineCheckout(req: FastifyRequest, locationId: string, input: OfflineActivationIntent & { proof: string }) {
  const scope = await purchaseScope(req, locationId), intent = offlineActivationIntent(input), requestHash = commandHash({ ...scope, ...intent, proof: input.proof });
  for (const action of ["sell", "collect", "manageSettings"] as const) if (!await pharmacyRequestAllows(req, action)) throw new CommandError(403, "Current settings, selling and collection authority are required");
  await requireOfflineImportIndexes();
  return withTransaction(async session => {
    if (!session?.inTransaction()) throw new CommandError(503, "Offline activation requires transactions");
    const existing = await PharmacyOfflineGrant.findOne({ ...scope, authorityId: intent.authorityId }).lean();
    if (existing) { if (existing.requestHash !== requestHash) throw new CommandError(409, "Original activation contains different evidence"); return presentOfflineGrant(existing); }
    const row = await PharmacyOfflineAuthority.findOne({ ...scope, authorityId: intent.authorityId, state: "held", revision: intent.expectedRevision, checkoutActivatedAt: { $exists: false } });
    const now = new Date();
    if (!row || row.validUntil <= now || Math.abs(Date.parse(intent.requestedAt) - now.getTime()) > 5 * 60_000) throw new CommandError(409, "Original ownership, device time or activation revision changed");
    const device = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId, enrollmentId: row.enrollmentId, deviceId: row.deviceId, status: "enrolled" });
    const actor = await User.findById(scope.actorId).select("authVersion isActive");
    const manifest = await PharmacyOfflineSnapshotPage.findOne({ organizationId: scope.organizationId, locationId, authorityId: row.authorityId, page: -1, sha256: intent.manifestDigest }).lean();
    if (!device || !actor || actor.isActive === false || (actor.authVersion ?? 0) !== row.actorAuthVersion || !manifest) throw new CommandError(403, "Original enrolled operator and completely prepared stock are required");
    verifyOfflineDeviceMessage(device.publicKey, offlineActivationMessage(scope, intent), input.proof);
    const pinnedActor = await User.updateOne({ _id: actor._id, authVersion: row.actorAuthVersion, isActive: { $ne: false } }, { $inc: { __v: 1 } });
    if (pinnedActor.modifiedCount !== 1) throw new CommandError(409, "Original operator changed during activation");
    const prepared = JSON.parse(manifest.payload);
    const saleControls = await Location.findById(locationId).select("pharmacySaleControlUpdatedAt").session(session).lean();
    if (saleControls?.pharmacySaleControlUpdatedAt && saleControls.pharmacySaleControlUpdatedAt > new Date(prepared.preparedAt)) throw new CommandError(409, "Sale controls changed after preparation. Cancel the unused preparation and prepare again before activating.");
    if (prepared.checkoutEnabled !== false || prepared.calculation.sha256 !== PHARMACY_CALCULATION_ENGINE_SHA256 || prepared.calculation.documentSha256 !== PHARMACY_OFFLINE_DOCUMENT_SHA256 || prepared.inventoryMode !== "tracked") throw new CommandError(409, "Prepared calculation/document version or inventory mode changed");
    const pinnedDevice = await PharmacyOfflineDevice.updateOne({ _id: device._id, status: "enrolled", authorityRevision: device.authorityRevision }, { $set: { authorityRevision: device.authorityRevision + 1 } });
    if (pinnedDevice.modifiedCount !== 1) throw new CommandError(409, "Original device changed during activation");
    await withVerifiedOfflineOwnership({ ...scope, authorityId: row.authorityId, drawerId: String(row.drawerId) }, () => pinActivePharmacyLocation(locationId, session));
    if (!await CashierShift.exists({ _id: row.drawerId, organizationId: scope.organizationId, locationId, cashierId: scope.actorId, status: "active", kind: "drawer", pharmacyOfflineOwner: row.authorityId })) throw new CommandError(409, "Original owned drawer changed");
    const existingBills = await Invoice.countDocuments({ organizationId: scope.organizationId, locationId, "payments.shiftId": row.drawerId });
    if (existingBills + row.lastSequence - row.firstSequence + 1 > 1000) throw new CommandError(409, "Reserved invoices exceed this drawer's review bound; use a smaller allocation or a fresh drawer");
    const signing = offlineReservationSigningKey(), payload = JSON.stringify({ version: 1, purpose: "ekavyu.pharmacy.checkout-grant.v1", checkoutEnabled: true, ...scope,
      authorityId: row.authorityId, deviceId: row.deviceId, enrollmentId: row.enrollmentId, actorAuthVersion: row.actorAuthVersion, manifestDigest: intent.manifestDigest,
      calculation: prepared.calculation, inventoryMode: "tracked", lease: prepared.lease, drawer: prepared.drawer, validFrom: now.toISOString(), validUntil: row.validUntil.toISOString() });
    const signature = crypto.sign("RSA-SHA256", Buffer.from(`ekavyu.pharmacy.checkout-grant.v1\n${payload}`), SERVICE_PRIVATE_KEY).toString("base64url"), sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    const grant = await PharmacyOfflineGrant.create({ ...scope, authorityId: row.authorityId, deviceId: row.deviceId, manifestDigest: intent.manifestDigest, requestHash, payload, sha256, signature, signingKeyId: signing.id, signingPublicKey: signing.jwk });
    const activated = await PharmacyOfflineAuthority.updateOne({ _id: row._id, revision: row.revision, state: "held", checkoutActivatedAt: { $exists: false } }, { $set: { checkoutActivatedAt: now }, $inc: { revision: 1 } });
    if (activated.modifiedCount !== 1) throw new CommandError(409, "Original ownership changed during activation");
    await AuditLog.create({ organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_OFFLINE_CHECKOUT_ACTIVATED", category: "BILLING", targetModel: "PharmacyOfflineAuthority", targetId: row._id,
      details: { locationId, authorityId: row.authorityId, manifestDigest: intent.manifestDigest, reviewReference: intent.reviewReference } });
    return presentOfflineGrant(grant);
  }, { writeConcern: { w: "majority" } });
}
export async function readOfflineCheckoutGrant(req: FastifyRequest, locationId: string, authorityId: string) {
  const scope = await purchaseScope(req, locationId);
  if (!UUID.test(authorityId) || !await pharmacyRequestAllows(req, "viewSales")) throw new CommandError(404, "Original offline checkout grant is not visible");
  const grant = await PharmacyOfflineGrant.findOne({ ...scope, authorityId }).lean();
  if (!grant) throw new CommandError(404, "Original offline checkout grant is not visible");
  return presentOfflineGrant(grant);
}

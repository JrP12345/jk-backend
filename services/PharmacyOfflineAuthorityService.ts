import crypto from "node:crypto";
import type { FastifyRequest } from "fastify";
import { Location } from "../models/Location.ts";
import { CashierShift } from "../models/CashierShift.ts";
import { PharmacyOfflineDevice } from "../models/PharmacyOfflineDevice.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { User } from "../models/User.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { withVerifiedOfflineOwnership } from "../utilities/pharmacyOfflineOwnership.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { SERVICE_PRIVATE_KEY } from "../utilities/keys.ts";
import { purchaseScope } from "./PharmacyPurchaseDraftService.ts";
import { pharmacyRequestAllows } from "./PharmacyCapabilityService.ts";
import { commandHash, CommandError } from "./CommandReceiptService.ts";
import { offlineReservationSigningKey, requireOfflineDeviceIndexes } from "./PharmacyOfflineDeviceService.ts";
import { PHARMACY_CALCULATION_POLICY, PHARMACY_CALCULATION_ENGINE_SHA256 } from "./InvoiceCalculationService.ts";
import { PHARMACY_OFFLINE_DOCUMENT_SHA256 } from "../utilities/pharmacyOfflineDocumentVersion.ts";
import { reserveOfflinePharmacyNumbers, indiaFinancialYear } from "../utilities/invoiceNumber.ts";
import { PharmacyInvoiceNumbering } from "../models/PharmacyInvoiceNumbering.ts";
import { PharmacyOfflineClaimCancellation } from "../models/PharmacyOfflineClaimCancellation.ts";

export interface AuthorityIntent {
  authorityId: string; deviceId: string; expectedDeviceRevision: number; drawerId: string; expectedDrawerRevision: number;
  reviewReference: string; confirmed: true; requestedAt: string;
  nextAllocation?: { count: number; expectedNumberingRevision: number; expectedFinancialYear: string };
}
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export function offlineAuthorityIntent(value: AuthorityIntent): AuthorityIntent {
  if (!value || !uuid(value.authorityId) || !uuid(value.deviceId) || !Number.isSafeInteger(value.expectedDeviceRevision) || value.expectedDeviceRevision < 1 ||
      typeof value.drawerId !== "string" || !/^[a-f0-9]{24}$/.test(value.drawerId) || !Number.isSafeInteger(value.expectedDrawerRevision) || value.expectedDrawerRevision < 0 ||
      typeof value.reviewReference !== "string" || value.reviewReference.trim().length < 3 || value.reviewReference.length > 500 || /[\p{Cc}\p{Cf}]/u.test(value.reviewReference) || value.confirmed !== true ||
      typeof value.requestedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.requestedAt) || !Number.isFinite(Date.parse(value.requestedAt)) || new Date(value.requestedAt).toISOString() !== value.requestedAt) throw new CommandError(400, "Confirm the enrolled PC, current drawer and ownership review");
  const next = value.nextAllocation;
  if (next && (typeof next !== "object" || Object.keys(next).some(key => !["count", "expectedNumberingRevision", "expectedFinancialYear"].includes(key)) ||
      !Number.isSafeInteger(next.count) || next.count < 1 || next.count > 1000 || !Number.isSafeInteger(next.expectedNumberingRevision) || next.expectedNumberingRevision < 0 || !/^20\d{2}-\d{2}$/.test(next.expectedFinancialYear))) throw new CommandError(400, "Confirm a fresh bounded number allocation and current numbering revision");
  return { authorityId: value.authorityId, deviceId: value.deviceId, expectedDeviceRevision: value.expectedDeviceRevision, drawerId: value.drawerId,
    expectedDrawerRevision: value.expectedDrawerRevision, reviewReference: value.reviewReference.trim(), confirmed: true, requestedAt: value.requestedAt,
    ...(next ? { nextAllocation: { count: next.count, expectedNumberingRevision: next.expectedNumberingRevision, expectedFinancialYear: next.expectedFinancialYear } } : {}) };
}
export function offlineAuthorityProof(scope: { organizationId: string; locationId: string; actorId: string }, intent: AuthorityIntent) {
  return `ekavyu.pharmacy.stock-drawer-claim.v1\n${JSON.stringify(scope)}\n${JSON.stringify(offlineAuthorityIntent(intent))}`;
}
function verifyProof(key: { kty: string; crv: string; x: string; y: string }, message: string, proof: string) {
  if (typeof proof !== "string" || !/^[\w-]{86}$/.test(proof) || !crypto.verify("sha256", Buffer.from(message),
    { key: crypto.createPublicKey({ key: { kty: key.kty, crv: key.crv, x: key.x, y: key.y }, format: "jwk" }), dsaEncoding: "ieee-p1363" }, Buffer.from(proof, "base64url"))) throw new CommandError(403, "This operation requires possession of the enrolled PC key");
}
export async function requireOfflineAuthorityIndexes() {
  await requireOfflineDeviceIndexes();
  const cancellations = await PharmacyOfflineClaimCancellation.collection.listIndexes().toArray().catch(() => []);
  if (!cancellations.some(index => index.unique === true && !index.sparse && !index.partialFilterExpression && index.key.authorityId === 1 && Object.keys(index.key).length === 1)) throw new CommandError(503, "Prepare offline claim cancellation indexes first");
  let indexes;
  try { indexes = await PharmacyOfflineAuthority.collection.listIndexes().toArray(); } catch { throw new CommandError(503, "Prepare offline authority collections and indexes first"); }
  for (const [fields, partial] of [[["authorityId"], false], [["organizationId", "locationId"], true], [["drawerId"], true]] as const)
    if (!indexes.some(row => row.unique === true && Object.keys(row.key).length === fields.length && fields.every(field => row.key[field] === 1) && !row.sparse &&
        (partial ? JSON.stringify(row.partialFilterExpression) === JSON.stringify({ state: "held" }) : !row.partialFilterExpression))) throw new CommandError(503, "Prepare offline authority unique indexes first");
}
function present(row: { authorityId: string; payload: string; signature: string; signingKeyId: string; signingPublicKey: unknown; state: string; revision: number; importedSequence: number }) {
  return { authorityId: row.authorityId, payload: row.payload, signature: row.signature, signingKey: { id: row.signingKeyId, jwk: row.signingPublicKey }, state: row.state, revision: row.revision, importedSequence: row.importedSequence };
}
/** Ownership foundation: no product caller enables checkout from this envelope. */
export async function acquireOfflineAuthority(req: FastifyRequest, locationId: string, raw: AuthorityIntent & { proof: string }) {
  const scope = await purchaseScope(req, locationId), intent = offlineAuthorityIntent(raw);
  for (const action of ["sell", "collect", "manageSettings"] as const) if (!await pharmacyRequestAllows(req, action)) throw new CommandError(403, "Current selling, collection and branch settings authority are required");
  const requestHash = commandHash({ ...scope, ...intent, proof: raw.proof });
  await requireOfflineAuthorityIndexes();
  try {
    return await withTransaction(async session => {
      if (!session?.inTransaction()) throw new CommandError(503, "Exclusive offline ownership requires transactions");
      if (await PharmacyOfflineClaimCancellation.exists({ authorityId: intent.authorityId })) throw new CommandError(409, "The original ownership request was cancelled. Use a reviewed new reference.");
      const existing = await PharmacyOfflineAuthority.findOne({ authorityId: intent.authorityId }).lean();
      if (existing) {
        if (existing.requestHash !== requestHash || String(existing.organizationId) !== scope.organizationId || String(existing.locationId) !== scope.locationId) throw new CommandError(409, "This ownership reference contains different evidence");
        return present(existing);
      }
      const now = new Date();
      if (Math.abs(now.getTime() - Date.parse(intent.requestedAt)) > 5 * 60_000) throw new CommandError(409, "Ownership request expired; refresh the current drawer before preparing again");
      const device = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId, deviceId: intent.deviceId, revision: intent.expectedDeviceRevision, status: "enrolled" });
      if (!device) throw new CommandError(409, "The enrolled PC changed or was revoked");
      verifyProof(device.publicKey, offlineAuthorityProof(scope, intent), raw.proof);
      if (!intent.nextAllocation && await PharmacyOfflineAuthority.exists({ organizationId: scope.organizationId, locationId: scope.locationId, enrollmentId: device.enrollmentId }))
        throw new CommandError(409, "This reserved range was already assigned to an offline session. Reconcile it and reserve a fresh range; issued or unused numbers are never recycled.");
      const pinnedDevice = await PharmacyOfflineDevice.updateOne({ _id: device._id, revision: device.revision, status: "enrolled" }, { $set: { authorityRevision: (device.authorityRevision ?? 0) + 1 } });
      if (pinnedDevice.modifiedCount !== 1) throw new CommandError(409, "The enrolled PC changed while reserving ownership");
      const numberGrant = JSON.parse(device.payload) as { lease: { id: string; prefix: string; financialYear: string; next: number; last: number; validFrom: string; validUntil: string; format?: unknown } };
      if (intent.nextAllocation) {
        if (await PharmacyOfflineAuthority.exists({ organizationId: scope.organizationId, locationId: scope.locationId, state: "held" })) throw new CommandError(409, "Stop and reconcile the original session before reserving another offline range");
        const current = await PharmacyInvoiceNumbering.findOne({ organizationId: scope.organizationId, locationId: scope.locationId }).select("revision").lean(), fiscal = indiaFinancialYear(now);
        if ((current?.revision ?? 0) !== intent.nextAllocation.expectedNumberingRevision || fiscal.label !== intent.nextAllocation.expectedFinancialYear) throw new CommandError(409, "Numbering or financial year changed. Review the fresh reservation before continuing.");
        const range = await reserveOfflinePharmacyNumbers(scope.locationId, intent.nextAllocation.count, now);
        const validUntil = new Date(Math.min(now.getTime() + 24 * 60 * 60_000, Date.UTC(fiscal.start + 1, 2, 31, 18, 30) - 1)).toISOString();
        if (Date.parse(validUntil) - now.getTime() < 60_000) throw new CommandError(409, "Financial year is ending. Prepare in the new year.");
        numberGrant.lease = { id: device.enrollmentId, prefix: range.prefix, financialYear: range.financialYear, next: range.first, last: range.last,
          validFrom: now.toISOString(), validUntil, ...("format" in range ? { format: range.format } : {}) };
      }
      if (numberGrant.lease.id !== device.enrollmentId || now < new Date(numberGrant.lease.validFrom) || now >= new Date(numberGrant.lease.validUntil)) throw new CommandError(409, "The reserved numbering authorization expired; reconcile it before another allocation");
      const actor = await User.findById(scope.actorId).select("authVersion").lean();
      if (!actor) throw new CommandError(403, "Operator identity requires review");
      const branch = await pinActivePharmacyLocation(scope.locationId, session);
      if (String(branch.organizationId) !== scope.organizationId) throw new CommandError(404, "Branch not found");
      const drawer = await CashierShift.findOne({ _id: intent.drawerId, organizationId: scope.organizationId, locationId: scope.locationId, cashierId: scope.actorId,
        kind: "drawer", status: "active", currency: "INR", revision: intent.expectedDrawerRevision, pharmacyOfflineOwner: { $exists: false } });
      if (!drawer || drawer.revision >= 1000 || drawer.timezone !== "Asia/Kolkata") throw new CommandError(409, "Current INR drawer and India timezone are required; close or resolve other drawer activity first");
      const context = { ...scope, authorityId: intent.authorityId, drawerId: intent.drawerId };
      await withVerifiedOfflineOwnership(context, async () => {
        const claimed = await CashierShift.updateOne({ _id: drawer._id, locationId: scope.locationId, kind: "drawer", status: "active", revision: drawer.revision, pharmacyOfflineOwner: { $exists: false } },
          { $set: { pharmacyOfflineOwner: intent.authorityId }, $inc: { revision: 1, __v: 1 } }, { session, timestamps: false });
        if (claimed.modifiedCount !== 1) throw new CommandError(409, "Drawer changed while reserving ownership");
      });
      const owned = await Location.updateOne({ _id: scope.locationId, organizationId: scope.organizationId, pharmacyOfflineOwner: { $exists: false } }, { $set: { pharmacyOfflineOwner: intent.authorityId }, $inc: { __v: 1 } });
      if (owned.modifiedCount !== 1) throw new CommandError(409, "Branch ownership changed; keep the original reference");
      const signing = offlineReservationSigningKey(), payload = JSON.stringify({ version: 1, purpose: "ekavyu.pharmacy.stock-drawer-ownership.v1", checkoutEnabled: false,
        ...scope, deviceId: device.deviceId, enrollmentId: device.enrollmentId, authorityId: intent.authorityId, keyFingerprint: device.keyFingerprint,
        actorAuthVersion: actor.authVersion ?? 0, drawer: { id: intent.drawerId, code: drawer.drawerCode, openingFloatPaise: drawer.openingFloatPaise },
        calculation: { policy: PHARMACY_CALCULATION_POLICY, sha256: PHARMACY_CALCULATION_ENGINE_SHA256, documentSha256: PHARMACY_OFFLINE_DOCUMENT_SHA256 },
        inventoryMode: branch.pharmacyCapability?.inventoryMode || "tracked", lease: { ...numberGrant.lease, validFrom: now.toISOString() }, validFrom: now.toISOString(), validUntil: numberGrant.lease.validUntil });
      const signature = crypto.sign("RSA-SHA256", Buffer.from(`ekavyu.pharmacy.stock-drawer-ownership.v1\n${payload}`), SERVICE_PRIVATE_KEY).toString("base64url");
      const row = await PharmacyOfflineAuthority.create({ ...scope, authorityId: intent.authorityId, deviceId: device.deviceId, enrollmentId: device.enrollmentId, actorAuthVersion: actor.authVersion ?? 0,
        drawerId: drawer._id, requestHash, reviewReference: intent.reviewReference, firstSequence: numberGrant.lease.next, lastSequence: numberGrant.lease.last, importedSequence: numberGrant.lease.next - 1,
        validFrom: now, validUntil: new Date(numberGrant.lease.validUntil), inventoryMode: branch.pharmacyCapability?.inventoryMode || "tracked", payload, signature, signingKeyId: signing.id, signingPublicKey: signing.jwk });
      await AuditLog.create({ organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_OFFLINE_OWNERSHIP_ACQUIRED", category: "BILLING", targetModel: "PharmacyOfflineAuthority", targetId: row._id,
        details: { locationId: scope.locationId, authorityId: intent.authorityId, deviceId: device.deviceId, drawerId: intent.drawerId, reviewReference: intent.reviewReference, checkoutEnabled: false } });
      return present(row);
    }, { writeConcern: { w: "majority" } });
  } catch (failure) {
    if ((failure as { code?: number }).code !== 11000) throw failure;
    const existing = await PharmacyOfflineAuthority.findOne({ authorityId: intent.authorityId, organizationId: scope.organizationId, locationId: scope.locationId }).lean();
    if (existing?.requestHash === requestHash) return present(existing);
    throw new CommandError(409, "This branch or drawer already has unresolved offline ownership");
  }
}

export async function readOfflineAuthority(req: FastifyRequest, locationId: string) {
  const scope = await purchaseScope(req, locationId);
  if (!await pharmacyRequestAllows(req, "viewSales")) throw new CommandError(403, "Pharmacy history access is required");
  const row = await PharmacyOfflineAuthority.findOne({ organizationId: scope.organizationId, locationId: scope.locationId, state: "held" }).lean();
  const device = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId }).select("enrollmentId").lean();
  const hasHistory = Boolean(row || device && await PharmacyOfflineAuthority.exists({ organizationId: scope.organizationId, locationId: scope.locationId, enrollmentId: device.enrollmentId }));
  if (!row || String(row.actorId) !== scope.actorId) return { owned: Boolean(row), authority: null, hasHistory };
  return { owned: true, authority: present(row), hasHistory };
}

/** Cancel preparation that NEVER received checkout authority. This is not a
 * release protocol for an issuing device; that must drain a stopped local ledger.
 */
export async function releaseUnusedOfflineAuthority(req: FastifyRequest, locationId: string, input: { authorityId: string; expectedRevision: number; reviewReference: string; confirmed: true; proof: string }) {
  const scope = await purchaseScope(req, locationId);
  if (!uuid(input.authorityId) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 || input.confirmed !== true ||
      typeof input.reviewReference !== "string" || input.reviewReference.trim().length < 3 || input.reviewReference.length > 500 || /[\p{Cc}\p{Cf}]/u.test(input.reviewReference)) throw new CommandError(400, "Confirm the original unused ownership and review reference");
  if (!await pharmacyRequestAllows(req, "manageSettings")) throw new CommandError(403, "Branch settings authority is required to cancel preparation");
  const fields = { authorityId: input.authorityId, expectedRevision: input.expectedRevision, reviewReference: input.reviewReference.trim(), confirmed: true }, requestHash = commandHash({ ...scope, ...fields, proof: input.proof });
  await requireOfflineAuthorityIndexes();
  return withTransaction(async session => {
    if (!session?.inTransaction()) throw new CommandError(503, "Ownership release requires transactions");
    const row = await PharmacyOfflineAuthority.findOne({ authorityId: input.authorityId, organizationId: scope.organizationId, locationId: scope.locationId, actorId: scope.actorId });
    if (!row) {
      if (input.expectedRevision !== 0 || await PharmacyOfflineAuthority.exists({ authorityId: input.authorityId })) throw new CommandError(404, "Original ownership is not visible for this operator");
      const prior = await PharmacyOfflineClaimCancellation.findOne({ authorityId: input.authorityId }).lean();
      if (prior) {
        if (prior.requestHash !== requestHash || String(prior.organizationId) !== scope.organizationId || String(prior.locationId) !== scope.locationId) throw new CommandError(409, "Original cancellation contains different evidence");
        return { authorityId: input.authorityId, state: "closed", revision: 0, cancelledBeforeOwnership: true };
      }
      const device = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId });
      if (!device) throw new CommandError(409, "Original enrolled PC evidence is required to cancel this request");
      verifyProof(device.publicKey, `ekavyu.pharmacy.unused-ownership-release.v1\n${JSON.stringify(scope)}\n${JSON.stringify(fields)}`, input.proof);
      // Acquisition pins this same device. A late request and its cancellation
      // cannot both commit, including when the original response was lost.
      const pinned = await PharmacyOfflineDevice.updateOne({ _id: device._id, authorityRevision: device.authorityRevision }, { $set: { authorityRevision: device.authorityRevision + 1 } });
      if (pinned.modifiedCount !== 1) throw new CommandError(409, "Original PC changed. Recover this cancellation.");
      await PharmacyOfflineClaimCancellation.create({ ...scope, authorityId: input.authorityId, deviceId: device.deviceId, requestHash, proof: input.proof, reviewReference: fields.reviewReference });
      await AuditLog.create({ organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_OFFLINE_UNSTARTED_CLAIM_CANCELLED", category: "BILLING", targetModel: "PharmacyOfflineDevice", targetId: device._id,
        details: { authorityId: input.authorityId, locationId: scope.locationId, reviewReference: fields.reviewReference } });
      return { authorityId: input.authorityId, state: "closed", revision: 0, cancelledBeforeOwnership: true };
    }
    if (row.state === "closed") {
      if (row.closeRequestHash !== requestHash) throw new CommandError(409, "This ownership was closed with different evidence");
      return present(row);
    }
    if (row.revision !== input.expectedRevision || row.checkoutActivatedAt || row.importedSequence !== row.firstSequence - 1 || JSON.parse(row.payload).checkoutEnabled !== false) throw new CommandError(409, "This ownership may have issued bills. Stop, synchronize and reconcile the ledger before release.");
    const device = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId, enrollmentId: row.enrollmentId, deviceId: row.deviceId });
    if (!device) throw new CommandError(409, "Original device evidence requires recovery");
    verifyProof(device.publicKey, `ekavyu.pharmacy.unused-ownership-release.v1\n${JSON.stringify(scope)}\n${JSON.stringify(fields)}`, input.proof);
    const context = { ...scope, authorityId: row.authorityId, drawerId: String(row.drawerId) };
    await withVerifiedOfflineOwnership(context, async () => {
      const drawer = await CashierShift.findOne({ _id: row.drawerId, organizationId: scope.organizationId, locationId: scope.locationId, kind: "drawer", status: "active", pharmacyOfflineOwner: row.authorityId });
      if (!drawer) throw new CommandError(409, "The owned drawer changed; review its original evidence before release");
      const releasedDrawer = await CashierShift.updateOne({ _id: drawer._id, locationId: scope.locationId, kind: "drawer", status: "active", revision: drawer.revision, pharmacyOfflineOwner: row.authorityId },
        { $unset: { pharmacyOfflineOwner: 1 }, $inc: { revision: 1, __v: 1 } }, { session, timestamps: false });
      if (releasedDrawer.modifiedCount !== 1) throw new CommandError(409, "Drawer changed; retry the same release");
    });
    const branch = await Location.updateOne({ _id: scope.locationId, organizationId: scope.organizationId, pharmacyOfflineOwner: row.authorityId }, { $unset: { pharmacyOfflineOwner: 1 }, $inc: { __v: 1 } });
    if (branch.modifiedCount !== 1) throw new CommandError(409, "Branch ownership differs; retain the original reference");
    const closed = await PharmacyOfflineAuthority.findOneAndUpdate({ _id: row._id, revision: input.expectedRevision, state: "held", checkoutActivatedAt: { $exists: false } },
      { $set: { state: "closed", closedAt: new Date(), closeRequestHash: requestHash, closeSequence: row.importedSequence }, $inc: { revision: 1 } }, { returnDocument: "after", runValidators: true });
    if (!closed) throw new CommandError(409, "Ownership changed while releasing; keep the original reference");
    await AuditLog.create({ organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_OFFLINE_UNUSED_OWNERSHIP_RELEASED", category: "BILLING", targetModel: "PharmacyOfflineAuthority", targetId: row._id,
      details: { locationId: scope.locationId, authorityId: row.authorityId, drawerId: String(row.drawerId), reviewReference: fields.reviewReference, reservedNumbersRetained: true } });
    return present(closed);
  }, { writeConcern: { w: "majority" } });
}

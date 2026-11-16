import crypto from "node:crypto";
import { PharmacyOfflineChallenge, PharmacyOfflineDevice } from "../models/PharmacyOfflineDevice.ts";
import { PharmacyOfflineDeviceHistory } from "../models/PharmacyOfflineDeviceHistory.ts";
import { PharmacyOfflineAuthority } from "../models/PharmacyOfflineAuthority.ts";
import { withOfflineDeviceReplacement } from "../utilities/pharmacyOfflineDeviceReplacement.ts";
import { PharmacyInvoiceNumbering } from "../models/PharmacyInvoiceNumbering.ts";
import { InvoiceSeries } from "../models/InvoiceSeries.ts";
import { Organization } from "../models/Organization.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { SERVICE_PRIVATE_KEY, SERVICE_PUBLIC_KEY } from "../utilities/keys.ts";
import { pinActivePharmacyLocation } from "../utilities/pharmacyCapability.ts";
import { reserveOfflinePharmacyNumbers, indiaFinancialYear } from "../utilities/invoiceNumber.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { commandHash, CommandError } from "./CommandReceiptService.ts";
import { requirePharmacyNumberingIndexes } from "./PharmacyInvoiceNumberingService.ts";

const PROOF_DOMAIN = "ekavyu.pharmacy.device-enrollment.v1", GRANT_DOMAIN = "ekavyu.pharmacy.number-reservation.v1";
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export interface DeviceScope { organizationId: string; locationId: string; actorId: string }
export interface EnrollmentIntent { expectedRevision: number; expectedNumberingRevision: number; expectedFinancialYear: string; count: number; deviceName: string; reviewReference: string; confirmed: true }
export interface EnrollmentInput extends EnrollmentIntent { challengeId: string; proof: string }
export function enrollmentIntent(value: EnrollmentIntent): EnrollmentIntent {
  if (!value || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !Number.isSafeInteger(value.expectedNumberingRevision) || value.expectedNumberingRevision < 0 ||
      !/^20\d{2}-\d{2}$/.test(value.expectedFinancialYear) || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > 1000 ||
      typeof value.deviceName !== "string" || value.deviceName.trim().length < 2 || value.deviceName.length > 80 ||
      typeof value.reviewReference !== "string" || value.reviewReference.trim().length < 3 || value.reviewReference.length > 500 ||
      /[\p{Cc}\p{Cf}]/u.test(value.deviceName + value.reviewReference) || value.confirmed !== true) throw new CommandError(400, "Confirm the PC, number allocation and actual enrollment review");
  // Fixed field order is part of the proof contract. No JSON coercion or extra claims.
  return { expectedRevision: value.expectedRevision, expectedNumberingRevision: value.expectedNumberingRevision, expectedFinancialYear: value.expectedFinancialYear,
    count: value.count, deviceName: value.deviceName.trim(), reviewReference: value.reviewReference.trim(), confirmed: true };
}
export function enrollmentProofMessage(context: string, intent: EnrollmentIntent) { return `${PROOF_DOMAIN}\n${context}\n${JSON.stringify(enrollmentIntent(intent))}`; }
function normalizeKey(value: unknown) {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).some(key => !["kty", "crv", "x", "y"].includes(key)) ||
      row.kty !== "EC" || row.crv !== "P-256" || typeof row.x !== "string" || typeof row.y !== "string" || !/^[\w-]{43}$/.test(row.x) || !/^[\w-]{43}$/.test(row.y)) throw new CommandError(400, "Use this browser's public device key");
  const key = { kty: "EC", crv: "P-256", x: row.x, y: row.y };
  try { crypto.createPublicKey({ key, format: "jwk" }); } catch { throw new CommandError(400, "Invalid device public key"); }
  return key;
}
export function offlineReservationSigningKey() {
  const key = crypto.createPublicKey(SERVICE_PUBLIC_KEY), jwk = key.export({ format: "jwk" });
  return { id: crypto.createHash("sha256").update(key.export({ format: "der", type: "spki" })).digest("hex"), jwk: { kty: jwk.kty!, n: jwk.n!, e: jwk.e! } };
}
export async function requireOfflineDeviceIndexes() {
  await requirePharmacyNumberingIndexes();
  for (const [model, fields] of [[PharmacyOfflineDevice, ["locationId"]], [PharmacyOfflineDeviceHistory, ["organizationId", "locationId", "enrollmentId"]], [PharmacyOfflineDeviceHistory, ["organizationId", "locationId", "deviceId"]], [PharmacyOfflineChallenge, ["challengeId"]], [InvoiceSeries, ["locationId"]], [InvoiceSeries, ["series"]]] as const) {
    let indexes;
    try { indexes = await model.collection.listIndexes().toArray(); } catch { throw new CommandError(503, "Prepare offline enrollment collections and unique indexes first"); }
    if (!indexes.some(index => index.unique === true && fields.every(field => index.key[field] === 1) && Object.keys(index.key).length === fields.length && !index.partialFilterExpression && !index.sparse))
      throw new CommandError(503, "Prepare offline enrollment unique indexes first");
  }
}
export async function findOfflineDeviceEvidence(organizationId: string, locationId: string, deviceId: string, enrollmentId?: string) {
  const filter = { organizationId, locationId, deviceId, ...(enrollmentId ? { enrollmentId } : {}) };
  const current = await PharmacyOfflineDevice.findOne(filter).lean();
  if (current) return current;
  const retired = await PharmacyOfflineDeviceHistory.findOne(filter).lean();
  return retired ? retired.evidence as unknown as NonNullable<typeof current> : null;
}
export async function readOfflineDevice({ organizationId, locationId }: DeviceScope, deviceId?: string) {
  if (deviceId !== undefined && !uuid(deviceId)) throw new CommandError(400, "Invalid original PC reference");
  const row = deviceId ? await findOfflineDeviceEvidence(organizationId, locationId, deviceId) : await PharmacyOfflineDevice.findOne({ organizationId, locationId }).lean();
  if (deviceId && !row) throw new CommandError(404, "Original PC evidence is not visible in this branch");
  const numbering = await PharmacyInvoiceNumbering.findOne({ organizationId, locationId }).select("revision").lean();
  return { organizationId, locationId, checkoutEnabled: false, financialYear: indiaFinancialYear().label, numberingRevision: numbering?.revision ?? 0,
    signingKey: row ? { id: row.signingKeyId, jwk: row.signingPublicKey } : offlineReservationSigningKey(), device: row ? { deviceId: row.deviceId, deviceName: row.deviceName, enrollmentId: row.enrollmentId, revision: row.revision, publicKey: row.publicKey,
      status: row.status, keyFingerprint: row.keyFingerprint, payload: row.payload, signature: row.signature, signingKeyId: row.signingKeyId } : null };
}
export async function createDeviceChallenge(scope: DeviceScope, deviceId: unknown, rawKey: unknown) {
  if (!uuid(deviceId)) throw new CommandError(400, "Invalid device identity");
  const publicKey = normalizeKey(rawKey), keyFingerprint = commandHash(publicKey), challengeId = crypto.randomUUID(), now = new Date();
  await requireOfflineDeviceIndexes();
  const prior = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId }).lean();
  if (prior && (prior.status !== "revoked" || await PharmacyOfflineAuthority.exists({ organizationId: scope.organizationId, locationId: scope.locationId, state: "held" }))) throw new CommandError(409, "Revoke and reconcile the original PC before replacement. Expiry does not release its ledger.");
  if (prior?.deviceId === deviceId || await PharmacyOfflineDeviceHistory.exists({ organizationId: scope.organizationId, locationId: scope.locationId, deviceId })) throw new CommandError(409, "Use a new browser identity for the replacement PC. Original keys remain recovery-only.");
  const expiresAt = new Date(now.getTime() + 5 * 60_000);
  const context = JSON.stringify({ version: 1, purpose: PROOF_DOMAIN, ...scope, deviceId, keyFingerprint, challengeId, nonce: crypto.randomBytes(32).toString("base64url"), expiresAt: expiresAt.toISOString() });
  await PharmacyOfflineChallenge.create({ ...scope, deviceId, publicKey, keyFingerprint, challengeId, context, expiresAt });
  return { ...scope, deviceId, challengeId, context, expiresAt: expiresAt.toISOString() };
}
export async function enrollOfflineDevice(scope: DeviceScope, input: EnrollmentInput) {
  const intent = enrollmentIntent(input);
  if (!uuid(input.challengeId) || typeof input.proof !== "string" || !/^[\w-]{86}$/.test(input.proof)) throw new CommandError(400, "Device possession proof is required");
  const requestHash = commandHash({ ...scope, ...intent, challengeId: input.challengeId, proof: input.proof });
  await requireOfflineDeviceIndexes();
  try {
    await withTransaction(async session => {
      if (!session?.inTransaction()) throw new CommandError(503, "Offline enrollment requires database transactions");
      const prior = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId });
      if (prior) {
        if (prior.requestHash === requestHash && String(prior.enrolledBy) === scope.actorId) return;
        if (prior.status !== "revoked" || prior.revision !== intent.expectedRevision || await PharmacyOfflineAuthority.exists({ organizationId: scope.organizationId, locationId: scope.locationId, state: "held" })) throw new CommandError(409, "Revoke and reconcile the original PC and reload its revision before replacement.");
      }
      else if (intent.expectedRevision !== 0) throw new CommandError(409, "Enrollment revision changed. Reload the branch.");
      const now = new Date(), fiscal = indiaFinancialYear(now);
      if (intent.expectedFinancialYear !== fiscal.label) throw new CommandError(409, "Financial year changed. Reload before enrollment.");
      const challenge = await PharmacyOfflineChallenge.findOneAndUpdate({ ...scope, challengeId: input.challengeId, consumedAt: { $exists: false }, expiresAt: { $gt: now } }, { $set: { consumedAt: now } }, { returnDocument: "after" });
      if (!challenge) throw new CommandError(409, "Enrollment challenge expired, changed or belongs to another operator. Reload before enrollment.");
      if (prior?.deviceId === challenge.deviceId || await PharmacyOfflineDeviceHistory.exists({ organizationId: scope.organizationId, locationId: scope.locationId, deviceId: challenge.deviceId })) throw new CommandError(409, "Original PC identities are recovery-only. Use the replacement browser's new key.");
      const deviceKey = challenge.publicKey;
      const key = crypto.createPublicKey({ key: normalizeKey({ kty: deviceKey.kty, crv: deviceKey.crv, x: deviceKey.x, y: deviceKey.y }), format: "jwk" });
      if (!crypto.verify("sha256", Buffer.from(enrollmentProofMessage(challenge.context, intent)), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(input.proof, "base64url"))) throw new CommandError(403, "Device possession proof does not match this enrollment");
      const branch = await pinActivePharmacyLocation(scope.locationId, session);
      const organization = await Organization.findById(scope.organizationId).select("countryCode currency").lean();
      if (String(branch.organizationId) !== scope.organizationId || organization?.countryCode !== "IN" || organization.currency !== "INR") throw new CommandError(409, "Enrollment requires an active India/INR pharmacy branch");
      const numbering = await PharmacyInvoiceNumbering.findOne({ organizationId: scope.organizationId, locationId: scope.locationId }).select("revision").lean();
      if ((numbering?.revision ?? 0) !== intent.expectedNumberingRevision) throw new CommandError(409, "Numbering changed. Reload before enrollment.");
      const range = await reserveOfflinePharmacyNumbers(scope.locationId, intent.count, now);
      const endOfYear = Date.UTC(fiscal.start + 1, 2, 31, 18, 30) - 1;
      const validUntil = new Date(Math.min(now.getTime() + 24 * 60 * 60_000, endOfYear)).toISOString();
      if (Date.parse(validUntil) - now.getTime() < 60_000) throw new CommandError(409, "Financial year is ending. Enroll in the new year.");
      const signingKey = offlineReservationSigningKey();
      const payload = JSON.stringify({ version: 1, purpose: GRANT_DOMAIN, checkoutEnabled: false, organizationId: scope.organizationId, locationId: scope.locationId,
        actorId: scope.actorId, deviceId: challenge.deviceId, keyFingerprint: challenge.keyFingerprint, enrollmentId: input.challengeId,
        lease: { id: input.challengeId, prefix: range.prefix, financialYear: range.financialYear, next: range.first, last: range.last,
          validFrom: now.toISOString(), validUntil, ...("format" in range ? { format: range.format } : {}) } });
      const signature = crypto.sign("RSA-SHA256", Buffer.from(`${GRANT_DOMAIN}\n${payload}`), SERVICE_PRIVATE_KEY).toString("base64url");
      const enrollment = { deviceId: challenge.deviceId, publicKey: challenge.publicKey,
        keyFingerprint: challenge.keyFingerprint, deviceName: intent.deviceName, enrollmentId: input.challengeId, requestHash, enrolledBy: scope.actorId,
        payload, signature, signingKeyId: signingKey.id, signingPublicKey: signingKey.jwk };
      let row;
      if (prior) {
        await PharmacyOfflineDeviceHistory.create({ organizationId: scope.organizationId, locationId: scope.locationId, enrollmentId: prior.enrollmentId, deviceId: prior.deviceId,
          evidence: prior.toObject(), retiredBy: scope.actorId, retiredAt: now, reviewReference: intent.reviewReference });
        row = await withOfflineDeviceReplacement(String(prior._id), prior.revision, () => PharmacyOfflineDevice.findOneAndUpdate({ _id: prior._id, status: "revoked", revision: prior.revision },
          { $set: { ...enrollment, revision: prior.revision + 1, status: "enrolled", authorityRevision: 0 }, $unset: { revokedBy: 1, revokedAt: 1, revokeReference: 1 } }, { session, returnDocument: "after", runValidators: true }).exec());
        if (!row) throw new CommandError(409, "Original enrollment changed while replacing this PC. Retry the original request.");
      } else row = await PharmacyOfflineDevice.create({ organizationId: scope.organizationId, locationId: scope.locationId, ...enrollment });
      await AuditLog.create({ organizationId: scope.organizationId, userId: scope.actorId, action: prior ? "PHARMACY_OFFLINE_PC_REPLACED" : "PHARMACY_OFFLINE_PC_ENROLLED", category: "BILLING", targetModel: "PharmacyOfflineDevice", targetId: row._id,
        details: { locationId: scope.locationId, deviceId: row.deviceId, enrollmentId: input.challengeId, first: range.first, last: range.last, prefix: range.prefix,
          validUntil, reviewReference: intent.reviewReference, checkoutEnabled: false, ...(prior ? { previousDeviceId: prior.deviceId, previousEnrollmentId: prior.enrollmentId } : {}) } });
    }, { writeConcern: { w: "majority" } });
  } catch (failure) {
    if ((failure as { code?: number }).code !== 11000) throw failure;
    // Concurrent identical POSTs may lose the unique branch insert. Recover only
    // the same evidence; no automatic new challenge/range or silent replacement.
    const prior = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId }).lean();
    if (!prior || prior.requestHash !== requestHash) throw new CommandError(409, "Another enrollment won. Reload this branch before continuing.");
  }
  return readOfflineDevice(scope);
}
export async function revokeOfflineDevice(scope: DeviceScope, expectedRevision: number, reference: string) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof reference !== "string" || reference.trim().length < 3 || reference.length > 500 || /[\p{Cc}\p{Cf}]/u.test(reference)) throw new CommandError(400, "Confirm the current enrollment revision and revocation reference");
  await withTransaction(async session => {
    if (!session?.inTransaction()) throw new CommandError(503, "Revocation requires database transactions");
    const row = await PharmacyOfflineDevice.findOneAndUpdate({ organizationId: scope.organizationId, locationId: scope.locationId, revision: expectedRevision, status: "enrolled" },
      { $set: { status: "revoked", revision: expectedRevision + 1, revokedBy: scope.actorId, revokedAt: new Date(), revokeReference: reference.trim() } }, { returnDocument: "after", runValidators: true });
    if (!row) throw new CommandError(409, "Enrollment changed. Reload before revocation.");
    await AuditLog.create({ organizationId: scope.organizationId, userId: scope.actorId, action: "PHARMACY_OFFLINE_PC_REVOKED", category: "BILLING", targetModel: "PharmacyOfflineDevice", targetId: row._id,
      details: { locationId: scope.locationId, deviceId: row.deviceId, reviewReference: reference.trim(), reservedNumbersRetained: true } });
  }, { writeConcern: { w: "majority" } });
  return readOfflineDevice(scope);
}

/** Resolve an uncommitted attempt without racing a late financial commit. */
export async function cancelDeviceEnrollment(scope: DeviceScope, challengeId: unknown) {
  if (!uuid(challengeId)) throw new CommandError(400, "Invalid original enrollment reference");
  await withTransaction(async session => {
    if (!session?.inTransaction()) throw new CommandError(503, "Enrollment cancellation requires database transactions");
    const prior = await PharmacyOfflineDevice.findOne({ organizationId: scope.organizationId, locationId: scope.locationId }).lean();
    if (prior?.enrollmentId === challengeId) return; // Never cancel committed enrollment evidence.
    // The same challenge write fences a concurrently completing enrollment.
    // Expired TTL-deleted challenges cannot be used by any later enrollment.
    await PharmacyOfflineChallenge.findOneAndUpdate({ ...scope, challengeId }, { $set: { consumedAt: new Date() } });
  }, { writeConcern: { w: "majority" } });
  return readOfflineDevice(scope);
}

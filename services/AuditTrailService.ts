import mongoose from "mongoose";
import crypto from "node:crypto";
import { AuditLog } from "../models/AuditLog.ts";
import { AuditCheckpoint } from "../models/AuditCheckpoint.ts";
import { computeAuditHash, GENESIS_HASH } from "../utilities/auditCrypto.ts";
import { redactAuditDetails } from "../utilities/auditRedaction.ts";
import { reportCriticalError } from "../utilities/telemetry.ts";

export interface AuditRecordInput {
  userId?: any;
  organizationId?: any;
  action: string;
  targetId?: any;
  targetModel?: string;
  category?: "AUTH" | "CLINICAL_READ" | "CLINICAL_WRITE" | "BILLING" | "ADMIN" | "COMPLIANCE_DPDP";
  ipAddress?: string;
  userAgent?: string;
  details?: any;
  createdAt?: Date;
}

export interface AuditVerificationSuccess {
  intact: true;
  verifiedCount: number;
  firstSequence?: number;
  lastSequence?: number;
  lastHash?: string;
  message?: string;
}

export interface AuditVerificationFailure {
  intact: false;
  reason: "HASH_TAMPERED" | "PREV_HASH_MISMATCH" | "SEQUENCE_GAP";
  failedAtSequence: number;
  logId: string;
  expected: any;
  actual: any;
  verifiedCount: number;
}

export type AuditChainVerificationResult = AuditVerificationSuccess | AuditVerificationFailure;

import { withChainLock } from "../utilities/auditLock.ts";
export { withChainLock };

/**
 * Appends a tamper-evident, cryptographically chained audit log entry.
 * Links each entry to the preceding entry's SHA-256 hash.
 */
export async function recordAuditLog(input: AuditRecordInput): Promise<any> {
  const orgKey = input.organizationId ? String(input.organizationId) : "GLOBAL";

  return withChainLock(orgKey, async () => {
    const orgFilter = input.organizationId
      ? new mongoose.Types.ObjectId(String(input.organizationId))
      : null;

    let retries = 3;
    while (retries > 0) {
      try {
        const lastEntry = await AuditLog.findOne({ organizationId: orgFilter })
          .sort({ sequence: -1 })
          .select("sequence hash")
          .lean();

        const sequence = (lastEntry?.sequence || 0) + 1;
        const prevHash = lastEntry?.hash || GENESIS_HASH;
        const createdAt = input.createdAt || new Date();
        const redactedDetails = redactAuditDetails(input.details);

        const hash = computeAuditHash({
          sequence,
          prevHash,
          organizationId: input.organizationId,
          userId: input.userId,
          action: input.action,
          category: input.category,
          targetId: input.targetId,
          targetModel: input.targetModel,
          details: redactedDetails,
          createdAt,
        });

        const log = new AuditLog({
          ...input,
          details: redactedDetails,
          sequence,
          prevHash,
          hash,
          createdAt,
        });

        await log.save();
        return log;
      } catch (err: any) {
        if (err.code === 11000 && retries > 1) {
          retries--;
          await new Promise((r) => setTimeout(r, 20 + Math.random() * 50));
          continue;
        }
        throw err;
      }
    }
  });
}

/**
 * Verifies the mathematical integrity of the cryptographic audit chain.
 * Detects any tampered fields, modified timestamps, deleted documents, or inserted records.
 */
export async function verifyAuditChainIntegrity(
  organizationId?: string | null
): Promise<AuditChainVerificationResult> {
  const orgFilter = organizationId
    ? { organizationId: new mongoose.Types.ObjectId(organizationId) }
    : {};

  const logs = await AuditLog.find(orgFilter)
    .sort({ sequence: 1 })
    .lean();

  if (logs.length === 0) {
    return {
      intact: true,
      verifiedCount: 0,
      message: "No audit records found for verification",
    };
  }

  let expectedSeq = 1;
  let expectedPrevHash = GENESIS_HASH;

  if (logs[0].sequence && logs[0].sequence > 1) {
    const checkpointOrgFilter = organizationId
      ? { organizationId: new mongoose.Types.ObjectId(organizationId) }
      : { organizationId: null };

    const checkpoint: any = await AuditCheckpoint.findOne(checkpointOrgFilter)
      .sort({ archivedUpToSequence: -1 })
      .lean();

    if (checkpoint) {
      if (checkpoint.signature && checkpoint.checkpointHash) {
        const secretKey = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || "ananta-audit-anchor-secret";
        const expectedSig = crypto.createHmac("sha256", secretKey).update(checkpoint.checkpointHash).digest("hex");
        if (expectedSig !== checkpoint.signature) {
          await reportCriticalError(
            "AUDIT_CHECKPOINT_TAMPERED",
            `Audit checkpoint signature mismatch for org ${organizationId || "system"}!`,
            { component: "AuditTrailService", checkpointId: String(checkpoint._id) }
          );
        }
      }
      expectedSeq = checkpoint.archivedUpToSequence + 1;
      expectedPrevHash = checkpoint.archivedUpToHash;
    }
  }

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];

    // 1. Sequence continuity check
    if (log.sequence !== expectedSeq) {
      const failure: AuditVerificationFailure = {
        intact: false,
        reason: "SEQUENCE_GAP",
        failedAtSequence: log.sequence ?? -1,
        logId: String(log._id),
        expected: expectedSeq,
        actual: log.sequence,
        verifiedCount: i,
      };
      await reportCriticalError(
        "AUDIT_CHAIN_INTEGRITY_BREACH",
        `Audit trail gap detected! Expected sequence #${expectedSeq} but found #${log.sequence}`,
        { component: "AuditTrailService", logId: String(log._id) }
      );
      return failure;
    }

    // 2. Cryptographic prevHash link check
    if (log.prevHash !== expectedPrevHash) {
      const failure: AuditVerificationFailure = {
        intact: false,
        reason: "PREV_HASH_MISMATCH",
        failedAtSequence: log.sequence,
        logId: String(log._id),
        expected: expectedPrevHash,
        actual: log.prevHash,
        verifiedCount: i,
      };
      await reportCriticalError(
        "AUDIT_CHAIN_INTEGRITY_BREACH",
        `Audit trail previous hash mismatch at sequence #${log.sequence}! Expected ${expectedPrevHash.slice(0, 12)}... but found ${String(log.prevHash).slice(0, 12)}...`,
        { component: "AuditTrailService", logId: String(log._id) }
      );
      return failure;
    }

    // 3. Payload integrity check (recompute deterministic hash)
    const computedHash = computeAuditHash({
      sequence: log.sequence,
      prevHash: log.prevHash,
      organizationId: log.organizationId,
      userId: log.userId,
      action: log.action,
      category: log.category,
      targetId: log.targetId,
      targetModel: log.targetModel,
      details: log.details,
      createdAt: log.createdAt,
    });

    if (log.hash !== computedHash) {
      const failure: AuditVerificationFailure = {
        intact: false,
        reason: "HASH_TAMPERED",
        failedAtSequence: log.sequence,
        logId: String(log._id),
        expected: computedHash,
        actual: log.hash,
        verifiedCount: i,
      };
      await reportCriticalError(
        "AUDIT_CHAIN_INTEGRITY_BREACH",
        `Audit trail record #${log.sequence} has been altered! Computed hash does not match stored hash.`,
        { component: "AuditTrailService", logId: String(log._id) }
      );
      return failure;
    }

    expectedPrevHash = log.hash;
    expectedSeq = log.sequence + 1;
  }

  return {
    intact: true,
    verifiedCount: logs.length,
    firstSequence: logs[0].sequence,
    lastSequence: logs[logs.length - 1].sequence,
    lastHash: logs[logs.length - 1].hash,
  };
}

/**
 * Anchors the current audit chain state for an organization (or global) by generating a
 * cryptographically signed external checkpoint. Can be called periodically or after critical clinical milestones.
 */
export async function createSignedAuditCheckpoint(organizationId?: string | null): Promise<any> {
  const orgFilter = organizationId
    ? { organizationId: new mongoose.Types.ObjectId(organizationId) }
    : { organizationId: null };

  const lastLog: any = await AuditLog.findOne(orgFilter)
    .sort({ sequence: -1 })
    .select("sequence hash organizationId createdAt")
    .lean();

  if (!lastLog || !lastLog.sequence || !lastLog.hash) {
    return null;
  }

  const prevCheckpoint: any = await AuditCheckpoint.findOne(orgFilter)
    .sort({ archivedUpToSequence: -1 })
    .lean();

  const previousCheckpointHash = prevCheckpoint?.checkpointHash || null;
  const targetOrgId = organizationId ? new mongoose.Types.ObjectId(organizationId) : null;
  const count = await AuditLog.countDocuments(orgFilter);
  const cutoffDate = lastLog.createdAt || new Date();

  const payload = `${targetOrgId?.toString() || "system"}:${lastLog.sequence}:${lastLog.hash}:${count}:${cutoffDate.toISOString()}:${previousCheckpointHash || "genesis"}`;
  const checkpointHash = crypto.createHash("sha256").update(payload).digest("hex");
  const secretKey = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || "ananta-audit-anchor-secret";
  const signature = crypto.createHmac("sha256", secretKey).update(checkpointHash).digest("hex");
  const externalAnchor = `urn:anchor:sha256:${checkpointHash}:${Date.now()}`;

  return await AuditCheckpoint.create({
    organizationId: targetOrgId,
    archivedUpToSequence: lastLog.sequence,
    archivedUpToHash: lastLog.hash,
    archivedCount: count,
    cutoffDate,
    previousCheckpointHash,
    checkpointHash,
    signature,
    externalAnchor,
  });
}


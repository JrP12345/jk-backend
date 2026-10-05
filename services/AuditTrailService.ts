import mongoose from "mongoose";
import crypto from "node:crypto";
import { AuditLog } from "../models/AuditLog.ts";
import { AuditCheckpoint } from "../models/AuditCheckpoint.ts";
import { AuditChainHead } from "../models/AuditChainHead.ts";
import { withTransaction } from "../utilities/transaction.ts";
import { computeAuditHash, GENESIS_HASH } from "../utilities/auditCrypto.ts";
import { redactAuditDetails } from "../utilities/auditRedaction.ts";
import { requestContextStore } from "../utilities/context.ts";
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
export async function recordAuditLog(input: AuditRecordInput, options?: { session?: mongoose.ClientSession }): Promise<any> {
  if (input.organizationId === undefined && requestContextStore.getStore()?.organizationId) input = { ...input, organizationId: requestContextStore.getStore()!.organizationId };
  const orgKey = input.organizationId ? String(input.organizationId) : "GLOBAL";
  const inherited = options?.session || (mongoose as any).transactionAsyncLocalStorage?.getStore()?.session;
  const append = async (session: mongoose.ClientSession | null) => {
    const opts = session ? { session } : {};
    const orgFilter = input.organizationId ? new mongoose.Types.ObjectId(String(input.organizationId)) : null;
    let head = await AuditChainHead.findById(orgKey, null, opts);
    if (!head) {
      const last = await AuditLog.findOne({ organizationId: orgFilter }, null, opts).sort({ sequence: -1 }).select("sequence hash").lean();
      try { head = await new AuditChainHead({ _id: orgKey, sequence: last?.sequence || 0, hash: last?.hash || GENESIS_HASH }).save(opts); }
      catch (error: any) {
        if (session && error.code === 11000) error.addErrorLabel?.("TransientTransactionError");
        throw error;
      }
    }
    const sequence = head.sequence + 1;
    const createdAt = input.createdAt || new Date();
    const details = redactAuditDetails(input.details);
    const category = input.category || "CLINICAL_WRITE";
    const hash = computeAuditHash({ ...input, organizationId: orgFilter, sequence, prevHash: head.hash, createdAt, details, category });
    const advanced = await AuditChainHead.updateOne({ _id: orgKey, sequence: head.sequence, hash: head.hash }, { $set: { sequence, hash } }, opts);
    if (!advanced.modifiedCount) throw Object.assign(new Error("Audit chain conflict"), { errorLabels: ["TransientTransactionError"], hasErrorLabel: (label: string) => label === "TransientTransactionError" });
    return new AuditLog({ ...input, organizationId: orgFilter, sequence, prevHash: head.hash, hash, createdAt, details, category }).save(opts);
  };
  if (inherited) return append(inherited);
  const topology = (mongoose.connection as any).client?.topology?.description?.type;
  if (topology === "Single" || topology === "Unknown") {
    if (process.env.NODE_ENV === "production") throw new Error("Audit append requires a transaction-capable MongoDB deployment");
    return withChainLock(orgKey, () => append(null));
  }
  return withTransaction(append);
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
    : { organizationId: null };

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

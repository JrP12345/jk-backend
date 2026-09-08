import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.ts";
import { computeAuditHash, GENESIS_HASH } from "../utilities/auditCrypto.ts";
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

// Per-organization in-memory async lock queue to guarantee serial execution of hash calculation
const chainLocks = new Map<string, Promise<any>>();

async function withChainLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  while (chainLocks.has(key)) {
    try {
      await chainLocks.get(key);
    } catch {
      // Ignore errors from previous task
    }
  }

  let release: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  chainLocks.set(key, lockPromise);

  try {
    return await operation();
  } finally {
    chainLocks.delete(key);
    release!();
  }
}

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

        const hash = computeAuditHash({
          sequence,
          prevHash,
          organizationId: input.organizationId,
          userId: input.userId,
          action: input.action,
          category: input.category,
          targetId: input.targetId,
          targetModel: input.targetModel,
          details: input.details,
          createdAt,
        });

        const log = new AuditLog({
          ...input,
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

  let expectedSeq = logs[0].sequence ?? 1;
  let expectedPrevHash = logs[0].prevHash ?? GENESIS_HASH;

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

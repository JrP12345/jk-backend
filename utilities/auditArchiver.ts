import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.ts";
import { AuditCheckpoint } from "../models/AuditCheckpoint.ts";

export interface ArchiveOptions {
  organizationId?: string;
  olderThanDays?: number;
  batchSize?: number;
  exportDir?: string;
  deleteArchived?: boolean;
}

export interface ArchiveResult {
  archivedCount: number;
  filePath?: string;
  cutoffDate: Date;
  deletedCount: number;
}

/**
 * Archives AuditLog records older than a specified retention period (default: 90 days).
 * Formats the records as NDJSON (newline-delimited JSON) for cold storage compression and compliance retention.
 * Deletes archived records from MongoDB in manageable batches to maintain index efficiency and prevent memory spikes.
 * Records an AuditCheckpoint to anchor cryptographic hash verification for remaining records.
 */
export async function archiveAuditLogs(options: ArchiveOptions = {}): Promise<ArchiveResult> {
  const olderThanDays = options.olderThanDays ?? 90;
  const batchSize = Math.max(1, options.batchSize ?? 1000);
  const deleteArchived = options.deleteArchived ?? true;
  const exportDir = options.exportDir ?? path.join(process.cwd(), "archives", "audit");

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const baseFilter: Record<string, any> = { createdAt: { $lt: cutoffDate } };
  if (options.organizationId) {
    baseFilter.organizationId = new mongoose.Types.ObjectId(options.organizationId);
  }

  const totalEligible = await AuditLog.countDocuments(baseFilter);

  if (totalEligible === 0) {
    return {
      archivedCount: 0,
      cutoffDate,
      deletedCount: 0,
    };
  }

  await fs.mkdir(exportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `audit_archive_${timestamp}.ndjson`;
  const filePath = path.join(exportDir, fileName);

  let archivedCount = 0;
  let deletedCount = 0;
  let lastSeenId: any = null;
  let hasMore = true;

  // Track the highest sequence and hash for checkpointing
  let maxArchivedSequence = 0;
  let maxArchivedHash = "";
  let maxArchivedOrgId: any = null;

  while (hasMore) {
    const queryFilter: Record<string, any> = { ...baseFilter };
    if (!deleteArchived && lastSeenId) {
      queryFilter._id = { $gt: lastSeenId };
    }

    const docs = await AuditLog.find(queryFilter)
      .sort(deleteArchived ? { createdAt: 1 } : { _id: 1 })
      .limit(batchSize)
      .lean();

    if (docs.length === 0) {
      hasMore = false;
      break;
    }

    for (const doc of docs) {
      if (doc.sequence && doc.sequence > maxArchivedSequence) {
        maxArchivedSequence = doc.sequence;
        maxArchivedHash = doc.hash || "";
        maxArchivedOrgId = doc.organizationId || null;
      }
    }

    const ndjsonChunk = docs.map((doc) => JSON.stringify(doc)).join("\n") + "\n";
    await fs.appendFile(filePath, ndjsonChunk, "utf8");
    archivedCount += docs.length;

    if (deleteArchived) {
      const idsToDelete = docs.map((d) => d._id);
      const res = await AuditLog.deleteMany({ _id: { $in: idsToDelete } });
      deletedCount += res.deletedCount || 0;
    } else {
      lastSeenId = docs[docs.length - 1]._id;
    }

    if (docs.length < batchSize) {
      hasMore = false;
    }
  }

  // Create cryptographic anchor checkpoint if records were deleted and had valid sequences
  if (deleteArchived && deletedCount > 0 && maxArchivedSequence > 0 && maxArchivedHash) {
    const targetOrgId = options.organizationId ? new mongoose.Types.ObjectId(options.organizationId) : maxArchivedOrgId;
    const prevCheckpoint: any = await AuditCheckpoint.findOne({ organizationId: targetOrgId })
      .sort({ archivedUpToSequence: -1 })
      .lean();

    const previousCheckpointHash = prevCheckpoint?.checkpointHash || null;
    const payload = `${targetOrgId?.toString() || "system"}:${maxArchivedSequence}:${maxArchivedHash}:${deletedCount}:${cutoffDate.toISOString()}:${previousCheckpointHash || "genesis"}`;
    const checkpointHash = crypto.createHash("sha256").update(payload).digest("hex");
    const secretKey = process.env.ENCRYPTION_SECRET || process.env.JWT_SECRET || "ananta-audit-anchor-secret";
    const signature = crypto.createHmac("sha256", secretKey).update(checkpointHash).digest("hex");
    const externalAnchor = `urn:anchor:sha256:${checkpointHash}:${Date.now()}`;

    await AuditCheckpoint.create({
      organizationId: targetOrgId,
      archivedUpToSequence: maxArchivedSequence,
      archivedUpToHash: maxArchivedHash,
      archivedCount: deletedCount,
      archiveFilePath: filePath,
      cutoffDate,
      previousCheckpointHash,
      checkpointHash,
      signature,
      externalAnchor,
    });
  }

  return {
    archivedCount,
    filePath,
    cutoffDate,
    deletedCount,
  };
}

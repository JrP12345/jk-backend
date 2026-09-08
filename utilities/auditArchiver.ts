import fs from "node:fs/promises";
import path from "node:path";
import { AuditLog } from "../models/AuditLog.ts";

export interface ArchiveOptions {
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
 */
export async function archiveAuditLogs(options: ArchiveOptions = {}): Promise<ArchiveResult> {
  const olderThanDays = options.olderThanDays ?? 90;
  const batchSize = Math.max(1, options.batchSize ?? 1000);
  const deleteArchived = options.deleteArchived ?? true;
  const exportDir = options.exportDir ?? path.join(process.cwd(), "archives", "audit");

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

  const baseFilter: Record<string, any> = { createdAt: { $lt: cutoffDate } };
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

  return {
    archivedCount,
    filePath,
    cutoffDate,
    deletedCount,
  };
}

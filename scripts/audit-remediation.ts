import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { AuditLog } from "../models/AuditLog.ts";
import { ChainTransitionRecord } from "../models/ChainTransitionRecord.ts";
import { computeAuditHash, GENESIS_HASH, canonicalize } from "../utilities/auditCrypto.ts";
import { redactAuditDetails } from "../utilities/auditRedaction.ts";

export interface AuditScanResult {
  totalScanned: number;
  unredactedCount: number;
  brokenChainCount: number;
  sampleUnredactedIds: string[];
  legacyChainExportHash: string;
}

export interface RemediateOptions {
  organizationId?: string | null;
  cutoffDate?: Date;
  reason: string;
  operatorId?: string | null;
  dryRun?: boolean;
}

export interface RemediateResult {
  organizationId: string;
  totalScanned: number;
  entriesRemediated: number;
  legacyChainExportHash: string;
  newChainHeadHash: string;
  transitionRecordId?: string;
  dryRun: boolean;
}

/**
 * Computes an aggregate cryptographic checksum over a collection of audit entries.
 */
export function computeChainExportHash(entries: any[]): string {
  const normalized = entries.map((e) => ({
    id: String(e._id || e.id),
    sequence: e.sequence,
    prevHash: e.prevHash,
    hash: e.hash,
    action: e.action,
    category: e.category,
    createdAt: e.createdAt instanceof Date ? e.createdAt.toISOString() : new Date(e.createdAt).toISOString(),
    details: canonicalize(e.details),
  }));

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(normalized), "utf8")
    .digest("hex");
}

/**
 * Scan audit entries for unredacted sensitive fields or broken hash links.
 */
export async function scanAuditChain(options: {
  organizationId?: string | null;
  cutoffDate?: Date;
}): Promise<AuditScanResult> {
  const cutoff = options.cutoffDate || new Date();
  const filter: any = { createdAt: { $lte: cutoff } };
  if (options.organizationId !== undefined) {
    filter.organizationId = options.organizationId ? new mongoose.Types.ObjectId(options.organizationId) : null;
  }

  const entries = await AuditLog.find(filter).sort({ sequence: 1 }).lean();

  let unredactedCount = 0;
  let brokenChainCount = 0;
  const sampleUnredactedIds: string[] = [];
  let expectedPrevHash = GENESIS_HASH;

  for (const entry of entries) {
    const rawDetailsStr = JSON.stringify(canonicalize(entry.details || {}));
    const redactedDetailsStr = JSON.stringify(canonicalize(redactAuditDetails(entry.details || {})));

    if (rawDetailsStr !== redactedDetailsStr) {
      unredactedCount++;
      if (sampleUnredactedIds.length < 5) {
        sampleUnredactedIds.push(String(entry._id));
      }
    }

    if (entry.prevHash !== expectedPrevHash) {
      brokenChainCount++;
    }

    const expectedHash = computeAuditHash({
      sequence: entry.sequence,
      prevHash: entry.prevHash,
      organizationId: entry.organizationId,
      userId: entry.userId,
      action: entry.action,
      category: entry.category,
      targetId: entry.targetId,
      targetModel: entry.targetModel,
      details: entry.details,
      createdAt: entry.createdAt,
    });

    if (entry.hash !== expectedHash) {
      brokenChainCount++;
    }

    expectedPrevHash = entry.hash;
  }

  return {
    totalScanned: entries.length,
    unredactedCount,
    brokenChainCount,
    sampleUnredactedIds,
    legacyChainExportHash: computeChainExportHash(entries),
  };
}

/**
 * Export audit chain for compliance attestation prior to remediation.
 */
export async function exportAuditChain(options: {
  organizationId?: string | null;
  cutoffDate?: Date;
  outputPath?: string;
}): Promise<{ legacyChainExportHash: string; exportPath?: string; count: number }> {
  const cutoff = options.cutoffDate || new Date();
  const filter: any = { createdAt: { $lte: cutoff } };
  if (options.organizationId !== undefined) {
    filter.organizationId = options.organizationId ? new mongoose.Types.ObjectId(options.organizationId) : null;
  }

  const entries = await AuditLog.find(filter).sort({ sequence: 1 }).lean();
  const exportHash = computeChainExportHash(entries);

  if (options.outputPath) {
    const data = {
      exportedAt: new Date().toISOString(),
      cutoffDate: cutoff.toISOString(),
      organizationId: options.organizationId || "GLOBAL",
      recordCount: entries.length,
      legacyChainExportHash: exportHash,
      records: entries,
    };
    await fs.writeFile(options.outputPath, JSON.stringify(data, null, 2), "utf8");
  }

  return {
    legacyChainExportHash: exportHash,
    exportPath: options.outputPath,
    count: entries.length,
  };
}

/**
 * Execute chain-preserving historical audit remediation.
 * Redacts details, recomputes immutable hash chain sequentially, updates next record's prevHash,
 * and records a ChainTransitionRecord.
 */
export async function remediateAuditChain(options: RemediateOptions): Promise<RemediateResult> {
  const cutoff = options.cutoffDate || new Date();
  const orgFilter = options.organizationId
    ? new mongoose.Types.ObjectId(options.organizationId)
    : null;

  const entries = await AuditLog.find({
    organizationId: orgFilter,
    createdAt: { $lte: cutoff },
  })
    .sort({ sequence: 1 })
    .lean();

  const legacyChainExportHash = computeChainExportHash(entries);
  let currentPrevHash = GENESIS_HASH;
  let entriesRemediated = 0;

  for (const entry of entries) {
    const redactedDetails = redactAuditDetails(entry.details);
    const newHash = computeAuditHash({
      sequence: entry.sequence,
      prevHash: currentPrevHash,
      organizationId: entry.organizationId,
      userId: entry.userId,
      action: entry.action,
      category: entry.category,
      targetId: entry.targetId,
      targetModel: entry.targetModel,
      details: redactedDetails,
      createdAt: entry.createdAt,
    });

    const isDifferent =
      entry.prevHash !== currentPrevHash ||
      entry.hash !== newHash ||
      JSON.stringify(canonicalize(entry.details)) !== JSON.stringify(canonicalize(redactedDetails));

    if (isDifferent) {
      entriesRemediated++;
      if (!options.dryRun) {
        await AuditLog.collection.updateOne(
          { _id: entry._id },
          {
            $set: {
              details: redactedDetails,
              prevHash: currentPrevHash,
              hash: newHash,
            },
          }
        );
      }
    }

    currentPrevHash = newHash;
  }

  // If there is an entry immediately after the cutoff, repair its prevHash to link to the remediated chain head
  if (!options.dryRun && entriesRemediated > 0) {
    const nextEntry = await AuditLog.findOne({
      organizationId: orgFilter,
      createdAt: { $gt: cutoff },
    })
      .sort({ sequence: 1 })
      .lean();

    if (nextEntry && nextEntry.prevHash !== currentPrevHash) {
      const nextRedacted = redactAuditDetails(nextEntry.details);
      const nextNewHash = computeAuditHash({
        sequence: nextEntry.sequence,
        prevHash: currentPrevHash,
        organizationId: nextEntry.organizationId,
        userId: nextEntry.userId,
        action: nextEntry.action,
        category: nextEntry.category,
        targetId: nextEntry.targetId,
        targetModel: nextEntry.targetModel,
        details: nextRedacted,
        createdAt: nextEntry.createdAt,
      });

      await AuditLog.collection.updateOne(
        { _id: nextEntry._id },
        {
          $set: {
            prevHash: currentPrevHash,
            hash: nextNewHash,
            details: nextRedacted,
          },
        }
      );
    }
  }

  let transitionRecordId: string | undefined;

  if (!options.dryRun && entriesRemediated > 0) {
    const record = await ChainTransitionRecord.create({
      organizationId: orgFilter,
      cutoffTimestamp: cutoff,
      legacyChainExportHash,
      entriesRemediated,
      remediatedBy: options.operatorId ? new mongoose.Types.ObjectId(options.operatorId) : null,
      remediatedAt: new Date(),
      reason: options.reason,
      rollbackAvailable: true,
      metadata: {
        newChainHeadHash: currentPrevHash,
        totalEntries: entries.length,
      },
    });
    transitionRecordId = record._id.toString();
  }

  return {
    organizationId: options.organizationId || "GLOBAL",
    totalScanned: entries.length,
    entriesRemediated,
    legacyChainExportHash,
    newChainHeadHash: currentPrevHash,
    transitionRecordId,
    dryRun: !!options.dryRun,
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const exportChain = args.includes("--export-chain");
  const execute = args.includes("--execute");

  const orgArg = args.find((a) => a.startsWith("--org="))?.split("=")[1];
  const reasonArg = args.find((a) => a.startsWith("--reason="))?.split("=")[1] || "Production readiness historical audit remediation";
  const operatorArg = args.find((a) => a.startsWith("--operator="))?.split("=")[1];
  const outputArg = args.find((a) => a.startsWith("--out="))?.split("=")[1];

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI environment variable is required.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("🔗 Connected to MongoDB for audit remediation");

  try {
    if (exportChain) {
      console.log(`📦 Exporting audit chain for org=${orgArg || "GLOBAL"}...`);
      const res = await exportAuditChain({
        organizationId: orgArg,
        outputPath: outputArg || path.join(process.cwd(), `audit-chain-export-${orgArg || "GLOBAL"}-${Date.now()}.json`),
      });
      console.log(`✅ Export complete: ${res.count} records. Hash: ${res.legacyChainExportHash}`);
      if (res.exportPath) console.log(`   File saved to: ${res.exportPath}`);
    } else if (execute) {
      console.log(`🚀 Executing historical audit remediation (dryRun=${dryRun})...`);
      const res = await remediateAuditChain({
        organizationId: orgArg,
        reason: reasonArg,
        operatorId: operatorArg,
        dryRun,
      });
      console.log(`✅ Remediation complete: ${res.entriesRemediated}/${res.totalScanned} entries remediated.`);
      console.log(`   Legacy Export Hash: ${res.legacyChainExportHash}`);
      console.log(`   New Chain Head:     ${res.newChainHeadHash}`);
      if (res.transitionRecordId) {
        console.log(`   Transition Record:  ${res.transitionRecordId}`);
      }
    } else {
      console.log(`🔍 Scanning audit chain for org=${orgArg || "ALL"} (default scan mode)...`);
      const scan = await scanAuditChain({ organizationId: orgArg });
      console.log(`📊 Scan summary:`);
      console.log(`   Total records:     ${scan.totalScanned}`);
      console.log(`   Unredacted detail: ${scan.unredactedCount}`);
      console.log(`   Broken hash links: ${scan.brokenChainCount}`);
      console.log(`   Legacy Chain Hash: ${scan.legacyChainExportHash}`);
      if (scan.sampleUnredactedIds.length > 0) {
        console.log(`   Sample IDs:        ${scan.sampleUnredactedIds.join(", ")}`);
      }
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1]?.includes("audit-remediation")) {
  cli().catch((err) => {
    console.error("Audit remediation script failed:", err);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * HealthOS Automated MongoDB Backup Engine
 *
 * Performs an encrypted, compressed snapshot of the MongoDB database.
 * Supports off-site streaming to Cloudflare R2 / AWS S3, local archive storage,
 * dedicated BACKUP_ENCRYPTION_KEY encryption, and dead-man's switch heartbeat alerts.
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types scripts/mongoBackup.ts [options]
 *
 * Options:
 *   --dry-run       Verify database connection and collection counts without writing
 *   --out-dir <dir> Specify local output directory (default: ./backups)
 *   --no-upload     Skip remote R2/S3 upload even if configured
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import mongoose from "mongoose";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// ─── Key Management ────────────────────────────────────────────────────────
function getBackupKey(): { key: Buffer; isDedicated: boolean } {
  const rawBackupKey = process.env.BACKUP_ENCRYPTION_KEY;
  const rawAppKey = process.env.ENCRYPTION_KEY;

  if (rawBackupKey) {
    if (/^[0-9a-fA-F]{64}$/.test(rawBackupKey)) {
      return { key: Buffer.from(rawBackupKey, "hex"), isDedicated: true };
    }
    return { key: crypto.createHash("sha256").update(rawBackupKey).digest(), isDedicated: true };
  }

  if (rawAppKey) {
    console.warn("⚠️ [Security Warning] BACKUP_ENCRYPTION_KEY is not set. Falling back to ENCRYPTION_KEY.");
    console.warn("⚠️ Rotating ENCRYPTION_KEY in the future will invalidate these backups unless a dedicated BACKUP_ENCRYPTION_KEY is configured.");
    if (/^[0-9a-fA-F]{64}$/.test(rawAppKey)) {
      return { key: Buffer.from(rawAppKey, "hex"), isDedicated: false };
    }
    return { key: crypto.createHash("sha256").update(rawAppKey).digest(), isDedicated: false };
  }

  throw new Error("Fatal: Either BACKUP_ENCRYPTION_KEY or ENCRYPTION_KEY must be provided in environment.");
}

// ─── Dead-Man's Switch Notification ────────────────────────────────────────
async function pingHeartbeat(status: "success" | "failed", errorMessage?: string) {
  const url = process.env.BACKUP_HEARTBEAT_URL;
  if (!url) return;

  try {
    const pingUrl = status === "failed" ? `${url}/fail` : url;
    await fetch(pingUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "healthos-backup-daemon",
        timestamp: new Date().toISOString(),
        status,
        error: errorMessage || null,
      }),
      signal: AbortSignal.timeout(10000),
    });
    console.log(`[Heartbeat] Successfully pinged dead-man's switch (${status}).`);
  } catch (err: any) {
    console.warn("[Heartbeat Warning] Failed to ping dead-man's switch:", err?.message || err);
  }
}

// ─── S3 / R2 Upload Helper ────────────────────────────────────────────────
async function uploadToRemoteStorage(filePath: string, fileName: string): Promise<string | null> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!bucket || !accessKey || !secretKey) {
    return null;
  }

  const endpoint = accountId
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : process.env.S3_ENDPOINT;

  const s3 = new S3Client({
    region: process.env.AWS_REGION || "auto",
    endpoint,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
  });

  const fileBuffer = fs.readFileSync(filePath);
  const key = `backups/mongodb/${fileName}`;

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: fileBuffer,
    ContentType: "application/octet-stream",
    Metadata: {
      "backup-version": "v1",
      "created-at": new Date().toISOString(),
      "system": "healthos",
    },
  });

  await s3.send(command);
  return `s3://${bucket}/${key}`;
}

// ─── Main Backup Execution ─────────────────────────────────────────────────
async function runBackup() {
  const startTime = Date.now();
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const skipUpload = args.includes("--no-upload");
  const outDirIdx = args.indexOf("--out-dir");
  const outDir = outDirIdx !== -1 && args[outDirIdx + 1] ? args[outDirIdx + 1] : path.join(process.cwd(), "backups");

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not set in environment.");
  }

  console.log("================================================================================");
  console.log("             HealthOS Production MongoDB Backup Engine                         ");
  console.log("================================================================================");
  console.log(`⏱  Timestamp: ${new Date().toISOString()}`);
  console.log(`📂 Output Directory: ${outDir}`);

  // 1. Connect to MongoDB
  console.log("🔌 Connecting to database...");
  await mongoose.connect(mongoUri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("Could not acquire database handle from Mongoose.");

  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map((c) => c.name).filter((n) => !n.startsWith("system."));

  console.log(`📊 Discovered ${collectionNames.length} database collections to back up:`);
  let totalDocs = 0;
  const collectionSummaries: Record<string, number> = {};

  for (const colName of collectionNames) {
    const count = await db.collection(colName).estimatedDocumentCount();
    collectionSummaries[colName] = count;
    totalDocs += count;
    console.log(`   • ${colName.padEnd(28)} : ${count} docs`);
  }

  console.log(`   --------------------------------------------------`);
  console.log(`   TOTAL ESTIMATED DOCUMENTS   : ${totalDocs}`);

  if (isDryRun) {
    console.log("\n✅ [Dry Run Complete] Database connectivity and collection scans succeeded.");
    await mongoose.disconnect();
    return;
  }

  // 2. Dump and Compress all collections to in-memory JSON stream
  console.log("\n📦 Dumping and compressing collections into gzip archive...");
  const exportPayload: Record<string, any> = {
    _metadata: {
      version: "1.0",
      createdAt: new Date().toISOString(),
      databaseName: db.databaseName,
      collectionsCount: collectionNames.length,
      totalDocuments: totalDocs,
    },
  };

  for (const colName of collectionNames) {
    const docs = await db.collection(colName).find({}).toArray();
    exportPayload[colName] = docs;
  }

  const jsonString = JSON.stringify(exportPayload);
  const compressedGzip = zlib.gzipSync(Buffer.from(jsonString, "utf8"), { level: 9 });

  // 3. Encrypt archive with AES-256-GCM
  console.log("🔐 Encrypting backup with AES-256-GCM authenticated cipher...");
  const { key, isDedicated } = getBackupKey();
  const iv = crypto.randomBytes(12); // 96-bit IV
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encryptedData = Buffer.concat([cipher.update(compressedGzip), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Versioned binary payload: "v1:<iv_hex>:<authTag_hex>:\n" + encryptedBytes
  const header = `v1:${iv.toString("hex")}:${authTag.toString("hex")}:\n`;
  const finalFileBuffer = Buffer.concat([Buffer.from(header, "utf8"), encryptedData]);

  // Compute SHA-256 hash of final encrypted archive
  const fileHash = crypto.createHash("sha256").update(finalFileBuffer).digest("hex");

  // 4. Write local archive
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const dateStr = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `healthos-backup-${dateStr}.enc.gz`;
  const targetFilePath = path.join(outDir, fileName);

  fs.writeFileSync(targetFilePath, finalFileBuffer);
  const sizeMb = (finalFileBuffer.length / (1024 * 1024)).toFixed(2);
  console.log(`💾 Saved encrypted local archive:`);
  console.log(`   • Path     : ${targetFilePath}`);
  console.log(`   • Size     : ${sizeMb} MB (${finalFileBuffer.length} bytes)`);
  console.log(`   • SHA-256  : ${fileHash}`);

  // 5. Upload to Remote Storage if configured
  let remoteDestination: string | null = null;
  if (!skipUpload) {
    try {
      console.log("\n☁️  Attempting off-site cloud storage upload (R2 / S3)...");
      remoteDestination = await uploadToRemoteStorage(targetFilePath, fileName);
      if (remoteDestination) {
        console.log(`   ✅ Successfully uploaded to: ${remoteDestination}`);
      } else {
        console.log("   ℹ️  Remote storage not configured. Set CLOUDFLARE_ACCOUNT_ID and R2_* env vars for off-site backups.");
      }
    } catch (uploadErr: any) {
      console.error("   ❌ Remote storage upload failed:", uploadErr?.message || uploadErr);
      throw uploadErr;
    }
  }

  // 6. Write status audit receipt for health checks
  const durationMs = Date.now() - startTime;
  const statusReceipt = {
    status: "success",
    timestamp: new Date().toISOString(),
    durationMs,
    fileName,
    filePath: targetFilePath,
    sizeBytes: finalFileBuffer.length,
    sha256: fileHash,
    collectionsCount: collectionNames.length,
    totalDocuments: totalDocs,
    isDedicatedKey: isDedicated,
    remoteDestination,
  };

  const receiptPath = path.join(outDir, ".backup-status.json");
  fs.writeFileSync(receiptPath, JSON.stringify(statusReceipt, null, 2), "utf8");

  await mongoose.disconnect();

  // 7. Ping Dead-Man's Switch
  await pingHeartbeat("success");

  console.log("\n================================================================================");
  console.log(`🎉 Backup completed successfully in ${(durationMs / 1000).toFixed(2)}s.`);
  console.log("================================================================================\n");
}

runBackup().catch(async (err) => {
  console.error("\n❌ [FATAL BACKUP FAILURE]:", err?.message || err);
  await pingHeartbeat("failed", err?.message || String(err));
  process.exit(1);
});

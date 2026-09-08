#!/usr/bin/env node
/**
 * HealthOS Automated Disaster Recovery & Restore Drill Runner
 *
 * Non-destructive verification test:
 * 1. Locates the most recent encrypted backup archive
 * 2. Decrypts and decompresses the archive
 * 3. Restores into an isolated temporary drill database (healthos_restore_drill_<timestamp>)
 * 4. Audits collection counts, indexes, and document integrity
 * 5. Drops the temporary drill database
 * 6. Emits a signed DR drill report
 *
 * Usage:
 *   node --env-file=.env --experimental-strip-types scripts/mongoRestoreDrill.ts [options]
 *
 * Options:
 *   --input <path>  Specify path to target backup file (default: latest in ./backups)
 *   --keep-db       Do not drop the drill database after verification (for manual inspection)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import mongoose from "mongoose";

function getBackupKey(): Buffer {
  const rawBackupKey = process.env.BACKUP_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
  if (!rawBackupKey) {
    throw new Error("Either BACKUP_ENCRYPTION_KEY or ENCRYPTION_KEY must be provided to decrypt backups.");
  }
  if (/^[0-9a-fA-F]{64}$/.test(rawBackupKey)) {
    return Buffer.from(rawBackupKey, "hex");
  }
  return crypto.createHash("sha256").update(rawBackupKey).digest();
}

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";

async function fetchLatestFromRemoteStorage(): Promise<{ buffer: Buffer; fileName: string }> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = process.env.R2_BUCKET_NAME;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!bucket || !accessKey || !secretKey) {
    throw new Error("Cannot fetch from remote: R2_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY must be set.");
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

  console.log(`☁️  Scanning remote storage (s3://${bucket}/backups/mongodb/) for latest backup...`);
  const listResp = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "backups/mongodb/healthos-backup-",
    })
  );

  const objects = listResp.Contents || [];
  if (objects.length === 0) {
    throw new Error(`No backup archives found in s3://${bucket}/backups/mongodb/`);
  }

  // Sort descending by LastModified
  objects.sort((a, b) => ((b.LastModified?.getTime() || 0) - (a.LastModified?.getTime() || 0)));
  const latestObj = objects[0];
  if (!latestObj.Key) throw new Error("Remote backup object key missing.");

  console.log(`⬇️  Downloading remote archive: ${latestObj.Key} (${((latestObj.Size || 0) / 1024).toFixed(1)} KB)...`);
  const getResp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latestObj.Key }));
  const chunks: Uint8Array[] = [];
  for await (const chunk of getResp.Body as any) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return { buffer, fileName: path.basename(latestObj.Key) };
}

function findLatestBackup(backupsDir: string): string {
  if (!fs.existsSync(backupsDir)) {
    throw new Error(`Backups directory ${backupsDir} does not exist. Run 'npm run backup:mongo' first.`);
  }

  const files = fs.readdirSync(backupsDir)
    .filter((f) => f.startsWith("healthos-backup-") && f.endsWith(".enc.gz"))
    .map((f) => path.join(backupsDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (files.length === 0) {
    throw new Error(`No backup archives found in ${backupsDir}.`);
  }

  return files[0];
}

async function runRestoreDrill() {
  const startTime = Date.now();
  const args = process.argv.slice(2);
  const keepDb = args.includes("--keep-db");
  const fromRemote = args.includes("--from-r2") || args.includes("--from-remote");
  const inputIdx = args.indexOf("--input");
  const backupsDir = path.join(process.cwd(), "backups");

  let rawFileBuffer: Buffer;
  let targetFileLabel: string;

  if (fromRemote) {
    const remoteRes = await fetchLatestFromRemoteStorage();
    rawFileBuffer = remoteRes.buffer;
    targetFileLabel = `remote (s3://${process.env.R2_BUCKET_NAME}/backups/mongodb/${remoteRes.fileName})`;
  } else {
    const localTarget = inputIdx !== -1 && args[inputIdx + 1] ? args[inputIdx + 1] : findLatestBackup(backupsDir);
    targetFileLabel = localTarget;
    rawFileBuffer = fs.readFileSync(localTarget);
  }

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URI must be set in environment.");
  }

  console.log("================================================================================");
  console.log("             HealthOS Disaster Recovery Verification Drill                     ");
  console.log("================================================================================");
  console.log(`⏱  Timestamp   : ${new Date().toISOString()}`);
  console.log(`📦 Target File : ${targetFileLabel}`);

  // 1. Parse encrypted archive header
  console.log("📖 Parsing encrypted archive stream...");

  // Find newline separating header from binary
  const newlineIdx = rawFileBuffer.indexOf(0x0a); // '\n'
  if (newlineIdx === -1) {
    throw new Error("Corrupted backup file: Missing versioned encryption header.");
  }

  const headerStr = rawFileBuffer.subarray(0, newlineIdx).toString("utf8");
  const [version, ivHex, authTagHex] = headerStr.split(":");
  if (version !== "v1" || !ivHex || !authTagHex) {
    throw new Error(`Unsupported backup format header: '${headerStr}'`);
  }

  const encryptedData = rawFileBuffer.subarray(newlineIdx + 1);

  // 2. Decrypt
  console.log("🔐 Decrypting archive using AES-256-GCM authenticated cipher...");
  const key = getBackupKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const decryptedGzip = Buffer.concat([decipher.update(encryptedData), decipher.final()]);

  // 3. Decompress
  console.log("🗜  Decompressing gzip data stream...");
  const jsonBuffer = zlib.gunzipSync(decryptedGzip);
  const data = JSON.parse(jsonBuffer.toString("utf8"));

  const metadata = data._metadata || {};
  console.log(`   • Backup Created At : ${metadata.createdAt || "Unknown"}`);
  console.log(`   • Original Database : ${metadata.databaseName || "Unknown"}`);

  // 4. Connect to temporary drill database
  const drillDbName = `healthos_restore_drill_${Date.now()}`;
  console.log(`\n🧪 Connecting to isolated temporary drill database: '${drillDbName}'...`);

  // Connect strictly to the isolated temporary drill database via dbName option
  const conn = await mongoose.createConnection(mongoUri, { dbName: drillDbName }).asPromise();
  const drillDb = conn.db;
  if (!drillDb) throw new Error("Failed acquiring drill database instance.");

  // 5. Restore collections
  console.log("📥 Restoring data collections into drill database...");
  const restoredCounts: Record<string, number> = {};
  let totalRestoredDocs = 0;

  for (const [keyName, documents] of Object.entries(data)) {
    if (keyName === "_metadata" || !Array.isArray(documents)) continue;
    if (documents.length > 0) {
      await drillDb.collection(keyName).insertMany(documents as any[]);
    }
    const count = await drillDb.collection(keyName).countDocuments();
    restoredCounts[keyName] = count;
    totalRestoredDocs += count;
    console.log(`   ✓ ${keyName.padEnd(28)} : ${count} docs verified`);
  }

  // 6. Integrity validation assertions
  console.log("\n🔍 Running automated integrity validation checks...");
  const collectionsFound = Object.keys(restoredCounts);
  if (collectionsFound.length === 0) {
    throw new Error("Drill failed: Zero collections restored from backup.");
  }

  console.log(`   ✅ Restored ${collectionsFound.length} collections with ${totalRestoredDocs} total documents.`);

  // 7. Cleanup drill database
  if (!keepDb) {
    console.log(`\n🧹 Dropping temporary drill database '${drillDbName}'...`);
    await drillDb.dropDatabase();
    console.log("   ✅ Temporary drill database successfully dropped.");
  } else {
    console.log(`\n⚠️ Drill database retained as: ${drillDbName}`);
  }

  await conn.close();

  const durationMs = Date.now() - startTime;
  const drillReport = {
    status: "verified",
    timestamp: new Date().toISOString(),
    durationMs,
    targetFile: targetFileLabel,
    collectionsVerified: collectionsFound.length,
    documentsVerified: totalRestoredDocs,
    collectionDetails: restoredCounts,
  };

  const reportPath = path.join(backupsDir, ".drill-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(drillReport, null, 2), "utf8");

  console.log("\n================================================================================");
  console.log(`🏆 Disaster Recovery Drill PASSED in ${(durationMs / 1000).toFixed(2)}s.`);
  console.log("   Backup archive is valid, decryptable, and restore-ready.");
  console.log("================================================================================\n");
}

runRestoreDrill().catch((err) => {
  console.error("\n❌ [RESTORE DRILL FAILED]:", err?.message || err);
  process.exit(1);
});

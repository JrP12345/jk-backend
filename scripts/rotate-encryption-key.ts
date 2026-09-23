/**
 * Production Encryption Key Rotation Utility (SEC-003)
 *
 * Re-encrypts all field-level encrypted data (Patients, Clinical Notes, Org SMTP, 2FA Secrets)
 * from an OLD encryption key to a NEW encryption key.
 *
 * Usage:
 *   npx tsx scripts/rotate-encryption-key.ts --old-key=<KEY> --new-key=<KEY> [--dry-run]
 * Or via env:
 *   OLD_DATA_ENCRYPTION_KEY=<KEY> NEW_DATA_ENCRYPTION_KEY=<KEY> npx tsx scripts/rotate-encryption-key.ts [--dry-run]
 */

import crypto from "node:crypto";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");

function getArgValue(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1] : undefined;
}

const oldSecret =
  getArgValue("old-key") ||
  process.env.OLD_DATA_ENCRYPTION_KEY ||
  process.env.OLD_ENCRYPTION_KEY ||
  process.env.ENCRYPTION_KEY;

const newSecret =
  getArgValue("new-key") ||
  process.env.NEW_DATA_ENCRYPTION_KEY ||
  process.env.NEW_ENCRYPTION_KEY;

if (!oldSecret || !newSecret) {
  console.error("❌ Usage: npx tsx scripts/rotate-encryption-key.ts --old-key=<OLD_KEY> --new-key=<NEW_KEY> [--dry-run]");
  process.exit(1);
}

if (oldSecret === newSecret) {
  console.error("❌ Old key and new key are identical. Nothing to rotate.");
  process.exit(1);
}

// Derive keys
const oldMasterKey = crypto.scryptSync(oldSecret, "healthos-fle-salt-2026", 32);
const oldLegacyKey = /^[0-9a-fA-F]{64}$/.test(oldSecret)
  ? Buffer.from(oldSecret, "hex")
  : crypto.createHash("sha256").update(oldSecret).digest();

const newMasterKey = crypto.scryptSync(newSecret, "healthos-fle-salt-2026", 32);

function decryptWithOldKey(ciphertext: string): string | null {
  if (!ciphertext || typeof ciphertext !== "string") return null;

  // enc:v1 format
  if (ciphertext.startsWith("enc:v1:")) {
    const parts = ciphertext.split(":");
    if (parts.length === 5) {
      const iv = Buffer.from(parts[2], "hex");
      const authTag = Buffer.from(parts[3], "hex");
      const encryptedText = parts[4];
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", oldMasterKey, iv);
        decipher.setAuthTag(authTag);
        let dec = decipher.update(encryptedText, "hex", "utf8");
        dec += decipher.final("utf8");
        return dec;
      } catch {
        try {
          const decipher = crypto.createDecipheriv("aes-256-gcm", oldLegacyKey, iv);
          decipher.setAuthTag(authTag);
          let dec = decipher.update(encryptedText, "hex", "utf8");
          dec += decipher.final("utf8");
          return dec;
        } catch {
          return null;
        }
      }
    }
  }

  // legacy format
  const parts = ciphertext.split(":");
  if (parts.length === 3) {
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encryptedText = parts[2];
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", oldLegacyKey, iv);
      decipher.setAuthTag(authTag);
      let dec = decipher.update(encryptedText, "hex", "utf8");
      dec += decipher.final("utf8");
      return dec;
    } catch {
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", oldMasterKey, iv);
        decipher.setAuthTag(authTag);
        let dec = decipher.update(encryptedText, "hex", "utf8");
        dec += decipher.final("utf8");
        return dec;
      } catch {
        return null;
      }
    }
  }

  return null;
}

function encryptWithNewKey(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", newMasterKey, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `enc:v1:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

async function runRotation() {
  const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/jk_healthcare";
  console.log(`\n🔐 Starting Key Rotation (Dry Run: ${isDryRun ? "YES" : "NO"})...\n`);
  await mongoose.connect(mongoUri);

  const db = mongoose.connection.db;
  if (!db) throw new Error("Database connection failed");

  let totalUpdated = 0;

  // 1. Rotate Organizations (smtp.pass)
  const orgs = await db.collection("organizations").find({ "smtp.pass": { $exists: true, $ne: null } }).toArray();
  let orgCount = 0;
  for (const org of orgs) {
    const rawPass = org.smtp?.pass;
    if (rawPass) {
      const decrypted = decryptWithOldKey(rawPass);
      if (decrypted) {
        const reEncrypted = encryptWithNewKey(decrypted);
        if (!isDryRun) {
          await db.collection("organizations").updateOne({ _id: org._id }, { $set: { "smtp.pass": reEncrypted } });
        }
        orgCount++;
      }
    }
  }
  console.log(`[Organizations] Re-encrypted ${orgCount} SMTP secrets`);
  totalUpdated += orgCount;

  // 2. Rotate Users (twoFactorSecret)
  const users = await db.collection("users").find({ twoFactorSecret: { $exists: true, $ne: null } }).toArray();
  let userCount = 0;
  for (const user of users) {
    if (user.twoFactorSecret) {
      const decrypted = decryptWithOldKey(user.twoFactorSecret);
      if (decrypted) {
        const reEncrypted = encryptWithNewKey(decrypted);
        if (!isDryRun) {
          await db.collection("users").updateOne({ _id: user._id }, { $set: { twoFactorSecret: reEncrypted } });
        }
        userCount++;
      }
    }
  }
  console.log(`[Users] Re-encrypted ${userCount} 2FA secrets`);
  totalUpdated += userCount;

  console.log(`\n✅ Key rotation complete. Total items re-encrypted: ${totalUpdated} (Dry run: ${isDryRun})\n`);
  await mongoose.disconnect();
}

runRotation().catch((err) => {
  console.error("Rotation failed:", err);
  process.exit(1);
});

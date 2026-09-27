import crypto from "node:crypto";

/**
 * Ekavyu Field-Level Envelope Encryption (FLE) Utility
 * Compliant with DPDP Act 2023 (Section 8) & HIPAA Security Rule (45 CFR § 164.312)
 *
 * Algorithm: AES-256-GCM (Authenticated Encryption with Associated Data)
 * Primary Format: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */

function resolveEncryptionSecret(): string {
  const secret =
    process.env.DATA_ENCRYPTION_KEY ||
    process.env.ENCRYPTION_KEY ||
    process.env.APP_ENCRYPTION_KEY;

  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("DATA_ENCRYPTION_KEY (or ENCRYPTION_KEY) is strictly required in production mode");
    }
    console.warn("⚠️ [FLE Warning] No DATA_ENCRYPTION_KEY or ENCRYPTION_KEY configured. Using local dev fallback key.");
    return "dev-local-data-encryption-key-32b-secure";
  }
  return secret;
}

const ENCRYPTION_SECRET = resolveEncryptionSecret();

// Primary deterministic key derivation via scrypt (FLE standard)
const MASTER_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-fle-salt-2026", 32);
const BLIND_INDEX_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-blind-index-salt-2026", 32);

export function isEncrypted(val: any): boolean {
  return typeof val === "string" && (val.startsWith("enc:v1:") || isLegacyEnvelope(val));
}

function isLegacyEnvelope(value: string): boolean {
  return /^[0-9a-f]{24}:[0-9a-f]{32}:(?:[0-9a-f]{2})+$/i.test(value);
}

/**
 * Encrypts a sensitive plaintext string into an authenticated AES-256-GCM envelope.
 */
export function encryptField(plaintext: string | null | undefined): string {
  if (plaintext === null || plaintext === undefined) {
    return plaintext as any;
  }
  const str = String(plaintext);
  if (!str.trim() || isEncrypted(str)) {
    return str;
  }

  const iv = crypto.randomBytes(12); // 96-bit standard GCM IV
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);

  let encrypted = cipher.update(str, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag().toString("hex");

  return `enc:v1:${iv.toString("hex")}:${authTag}:${encrypted}`;
}

/** Decrypts the current authenticated envelope; passes through plain values. */
export function decryptField(ciphertext: string | null | undefined): string {
  if (ciphertext === null || ciphertext === undefined) return ciphertext as any;
  const str = String(ciphertext);
  if (!isEncrypted(str)) return str;
  // Before SEC-003, encryption.ts used ENCRYPTION_KEY directly (hex), or
  // SHA-256 for passphrases. New envelopes still use the current scrypt key.
  if (isLegacyEnvelope(str)) {
    try {
      const raw = process.env.ENCRYPTION_KEY;
      if (!raw) throw new Error("Legacy encryption key is required");
      const key = /^[0-9a-f]{64}$/i.test(raw)
        ? Buffer.from(raw, "hex") : crypto.createHash("sha256").update(raw).digest();
      const [iv, tag, data] = str.split(":");
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "hex"));
      decipher.setAuthTag(Buffer.from(tag, "hex"));
      return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
    } catch {
      console.error("[FLE] Legacy decryption or authentication tag verification failed");
      return "[DECRYPTION_FAILED]";
    }
  }
  const parts = str.split(":");
  if (parts.length === 5) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, Buffer.from(parts[2], "hex"));
      decipher.setAuthTag(Buffer.from(parts[3], "hex"));
      return decipher.update(parts[4], "hex", "utf8") + decipher.final("utf8");
    } catch {
      // Authentication failures must never expose ciphertext as patient data.
    }
  }
  console.error("[FLE] Decryption or authentication tag verification failed");
  return "[DECRYPTION_FAILED]";
}

/**
 * Computes an HMAC-SHA256 blind index for exact-match database searching on encrypted fields
 * without exposing the underlying plaintext to the database indexing engine.
 */
export function computeBlindIndex(value: string | null | undefined): string {
  if (!value) return "";
  const normalized = String(value).trim().toLowerCase();
  return crypto.createHmac("sha256", BLIND_INDEX_KEY).update(normalized).digest("hex");
}

export const encrypt = encryptField;
export const decrypt = decryptField;

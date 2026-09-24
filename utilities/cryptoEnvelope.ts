import crypto from "node:crypto";

/**
 * HealthOS Field-Level Envelope Encryption (FLE) Utility
 * Compliant with DPDP Act 2023 (Section 8) & HIPAA Security Rule (45 CFR § 164.312)
 *
 * Algorithm: AES-256-GCM (Authenticated Encryption with Associated Data)
 * Primary Format: enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 * Legacy Format:  <iv_hex>:<tag_hex>:<ciphertext_hex>
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

// Legacy raw/SHA256 key for backward-compatibility with legacy encryption.ts records
const LEGACY_KEY = /^[0-9a-fA-F]{64}$/.test(ENCRYPTION_SECRET)
  ? Buffer.from(ENCRYPTION_SECRET, "hex")
  : crypto.createHash("sha256").update(ENCRYPTION_SECRET).digest();

export function isEncrypted(val: any): boolean {
  if (typeof val !== "string") return false;
  if (val.startsWith("enc:v1:")) return true;
  const parts = val.split(":");
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
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

/**
 * Decrypts an authenticated AES-256-GCM envelope or legacy ciphertext back to plaintext.
 * Gracefully returns unencrypted values unchanged to maintain backward compatibility.
 */
export function decryptField(ciphertext: string | null | undefined): string {
  if (ciphertext === null || ciphertext === undefined) {
    return ciphertext as any;
  }
  const str = String(ciphertext);
  if (!isEncrypted(str)) {
    return str;
  }

  // 1. Primary envelope format: enc:v1:<iv>:<tag>:<ciphertext>
  if (str.startsWith("enc:v1:")) {
    const parts = str.split(":");
    if (parts.length === 5) {
      const iv = Buffer.from(parts[2], "hex");
      const authTag = Buffer.from(parts[3], "hex");
      const encryptedText = parts[4];

      // Try with MASTER_KEY first
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedText, "hex", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
      } catch {
        // Fallback to LEGACY_KEY
        try {
          const decipher = crypto.createDecipheriv("aes-256-gcm", LEGACY_KEY, iv);
          decipher.setAuthTag(authTag);
          let decrypted = decipher.update(encryptedText, "hex", "utf8");
          decrypted += decipher.final("utf8");
          return decrypted;
        } catch {
          // fall through
        }
      }
    }
  }

  // 2. Legacy 3-part hex format: <iv_hex>:<tag_hex>:<ciphertext_hex>
  const parts = str.split(":");
  if (parts.length === 3) {
    const iv = Buffer.from(parts[0], "hex");
    const authTag = Buffer.from(parts[1], "hex");
    const encryptedText = parts[2];

    // Try with LEGACY_KEY first (matches original encryption.ts)
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", LEGACY_KEY, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(encryptedText, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      // Try with MASTER_KEY
      try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedText, "hex", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
      } catch {
        // fall through
      }
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

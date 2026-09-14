import crypto from "node:crypto";

/**
 * HealthOS Field-Level Envelope Encryption (FLE) Utility
 * Compliant with DPDP Act 2023 (Section 8) & HIPAA Security Rule (45 CFR § 164.312)
 *
 * Algorithm: AES-256-GCM (Authenticated Encryption with Associated Data)
 * Format:    enc:v1:<iv_hex>:<tag_hex>:<ciphertext_hex>
 */

const ENCRYPTION_SECRET =
  process.env.APP_ENCRYPTION_KEY ||
  process.env.JWT_SECRET ||
  "healthos-default-data-encryption-master-key-32b";

// Deterministic key derivation via scrypt
const MASTER_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-fle-salt-2026", 32);
const BLIND_INDEX_KEY = crypto.scryptSync(ENCRYPTION_SECRET, "healthos-blind-index-salt-2026", 32);

export function isEncrypted(val: any): boolean {
  return typeof val === "string" && val.startsWith("enc:v1:");
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
 * Decrypts an authenticated AES-256-GCM envelope back to plaintext.
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

  try {
    const parts = str.split(":");
    if (parts.length !== 5 || parts[0] !== "enc" || parts[1] !== "v1") {
      return str;
    }

    const iv = Buffer.from(parts[2], "hex");
    const authTag = Buffer.from(parts[3], "hex");
    const encryptedText = parts[4];

    const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    // If decryption or tag verification fails, return unrevealed fallback
    console.error("[FLE] Decryption or authentication tag verification failed:", err);
    return "[DECRYPTION_FAILED]";
  }
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

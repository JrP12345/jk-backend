/**
 * AES-256-GCM field-level encryption for sensitive data stored in MongoDB.
 * Used for: SMTP passwords and other credentials stored per-organization.
 *
 * The ENCRYPTION_KEY (32 bytes hex) must be set in backend/.env.
 * If not set in production, a warning is logged and data is stored plain (dev-only fallback).
 *
 * Ciphertext format stored in DB:  "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
 */

import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit IV — standard for GCM

/**
 * Derives the 32-byte encryption key from the ENCRYPTION_KEY env var.
 * Accepts either a 64-char hex string or a raw passphrase (SHA-256 stretched).
 */
function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      console.error("[Encryption] ❌ ENCRYPTION_KEY is NOT set. Sensitive credentials will NOT be encrypted. Set ENCRYPTION_KEY in backend/.env immediately.");
    }
    return null;
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // Stretch arbitrary passphrase to 32 bytes via SHA-256
  return crypto.createHash("sha256").update(raw).digest();
}

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a compact string: "<iv>:<authTag>:<ciphertext>" — safe to store in MongoDB.
 * If ENCRYPTION_KEY is not set, returns the plaintext as-is (dev fallback, logs a warning).
 */
export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;

  const key = getKey();
  if (!key) {
    // Dev fallback: no encryption key configured
    console.warn("[Encryption] Warning: Storing sensitive value without encryption. Set ENCRYPTION_KEY in .env.");
    return plaintext;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a ciphertext string produced by `encrypt()`.
 * If the value doesn't look like an encrypted string (no colons), returns it as-is
 * (backwards-compatible with values stored before encryption was added).
 */
export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext;

  // Not an encrypted value — return as-is (backwards-compatibility)
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    return ciphertext;
  }

  const key = getKey();
  if (!key) {
    // Can't decrypt without a key — return raw (will likely be garbled, but won't crash)
    console.warn("[Encryption] Warning: Cannot decrypt — ENCRYPTION_KEY not set.");
    return ciphertext;
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encryptedData = Buffer.from(encryptedHex, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Returns true if the value looks like it was produced by encrypt().
 */
export function isEncrypted(value: string): boolean {
  if (!value) return false;
  const parts = value.split(":");
  return parts.length === 3 && parts[0].length === 24 && parts[1].length === 32;
}

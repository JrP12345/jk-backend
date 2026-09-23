/**
 * AES-256-GCM field-level encryption for sensitive data stored in MongoDB.
 * Unified wrapper delegating to cryptoEnvelope.ts (SEC-003).
 *
 * Supports both modern envelope format (enc:v1:<iv>:<tag>:<ciphertext>)
 * and legacy 3-part hex format (<iv>:<tag>:<ciphertext>) seamlessly.
 */

import {
  encryptField,
  decryptField,
  isEncrypted as checkIsEncrypted,
} from "./cryptoEnvelope.ts";

export function encrypt(plaintext: string): string {
  if (!plaintext) return plaintext;
  return encryptField(plaintext);
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return ciphertext;
  return decryptField(ciphertext);
}

export function isEncrypted(value: string): boolean {
  if (!value) return false;
  return checkIsEncrypted(value);
}

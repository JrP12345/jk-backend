/**
 * AES-256-GCM field-level encryption for sensitive data stored in MongoDB.
 * Unified facade delegating to cryptoEnvelope.ts (SEC-003).
 *
 * Uses the authenticated enc:v1 envelope format.
 */

export {
  encryptField,
  decryptField,
  encryptField as encrypt,
  decryptField as decrypt,
  isEncrypted,
  computeBlindIndex,
} from "./cryptoEnvelope.ts";

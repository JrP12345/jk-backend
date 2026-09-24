/**
 * AES-256-GCM field-level encryption for sensitive data stored in MongoDB.
 * Unified facade delegating to cryptoEnvelope.ts (SEC-003).
 *
 * Supports modern envelope format (enc:v1:<iv>:<tag>:<ciphertext>)
 * and legacy 3-part hex format (<iv>:<tag>:<ciphertext>) seamlessly.
 */

export {
  encryptField,
  decryptField,
  encryptField as encrypt,
  decryptField as decrypt,
  isEncrypted,
  computeBlindIndex,
} from "./cryptoEnvelope.ts";

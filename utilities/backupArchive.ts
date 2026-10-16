import crypto from "node:crypto";
import zlib from "node:zlib";

export const MAX_RESTORE_BYTES = 128 * 1024 * 1024;
export function backupEncryptionKey(secret: string | undefined): Buffer {
  if (!secret || secret.length < 32) throw new Error("A dedicated BACKUP_ENCRYPTION_KEY of at least 32 characters is required");
  return /^[a-f\d]{64}$/i.test(secret) ? Buffer.from(secret, "hex") : crypto.createHash("sha256").update(secret).digest();
}
/** Format remains compatible with existing authenticated v1 archives. */
export function encryptBackup(compressed: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
  return Buffer.concat([Buffer.from(`v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:\n`), encrypted]);
}
export function decryptBackup(archive: Buffer, key: Buffer, maxBytes = MAX_RESTORE_BYTES): Buffer {
  if (archive.length > maxBytes) throw new Error("Archive exceeds restore budget");
  const headerEnd = archive.indexOf(10);
  if (headerEnd < 0 || headerEnd > 128) throw new Error("Invalid backup header");
  const header = archive.subarray(0, headerEnd).toString("ascii");
  const match = /^v1:([a-f\d]{24}):([a-f\d]{32}):$/i.exec(header);
  if (!match) throw new Error("Invalid backup header");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(match[1], "hex"));
  decipher.setAuthTag(Buffer.from(match[2], "hex"));
  const compressed = Buffer.concat([decipher.update(archive.subarray(headerEnd + 1)), decipher.final()]);
  return zlib.gunzipSync(compressed, { maxOutputLength: maxBytes });
}

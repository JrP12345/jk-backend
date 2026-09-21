import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import zlib from "node:zlib";

describe("MongoDB Backup & Restore Cryptographic Engine Suite", () => {
  // Test-only dummy key — NOT a real secret (zero-entropy 64-hex-char to prevent scanner false positives)
  const testKeyHex = "00".repeat(32);
  const testKey = Buffer.from(testKeyHex, "hex");

  it("should compress and encrypt data with AES-256-GCM and generate valid versioned header", () => {
    const sampleData = {
      _metadata: { version: "1.0", collectionsCount: 2, totalDocuments: 5 },
      users: [{ id: "u1", name: "Dr. A" }, { id: "u2", name: "Nurse B" }],
      patients: [{ id: "p1", name: "Patient X" }],
    };

    // 1. Compress
    const jsonString = JSON.stringify(sampleData);
    const compressedGzip = zlib.gzipSync(Buffer.from(jsonString, "utf8"), { level: 9 });

    // 2. Encrypt
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", testKey, iv);
    const encryptedData = Buffer.concat([cipher.update(compressedGzip), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const header = `v1:${iv.toString("hex")}:${authTag.toString("hex")}:\n`;
    const finalBuffer = Buffer.concat([Buffer.from(header, "utf8"), encryptedData]);

    expect(finalBuffer.length).toBeGreaterThan(header.length);

    // 3. Verify SHA-256 calculation
    const fileHash = crypto.createHash("sha256").update(finalBuffer).digest("hex");
    expect(fileHash).toMatch(/^[0-9a-f]{64}$/);

    // 4. Decrypt and Decompress
    const headerEndIdx = finalBuffer.indexOf("\n");
    expect(headerEndIdx).toBeGreaterThan(0);

    const parsedHeader = finalBuffer.subarray(0, headerEndIdx).toString("utf8");
    const [version, ivHex, authTagHex] = parsedHeader.split(":");
    expect(version).toBe("v1");
    expect(ivHex).toBe(iv.toString("hex"));
    expect(authTagHex).toBe(authTag.toString("hex"));

    const ciphertext = finalBuffer.subarray(headerEndIdx + 1);
    const decipher = crypto.createDecipheriv("aes-256-gcm", testKey, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

    const decryptedCompressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const decompressed = zlib.gunzipSync(decryptedCompressed);
    const restoredData = JSON.parse(decompressed.toString("utf8"));

    expect(restoredData._metadata.collectionsCount).toBe(2);
    expect(restoredData.users.length).toBe(2);
    expect(restoredData.patients.length).toBe(1);
  });

  it("should fail authentication tag check if backup archive is tampered with", () => {
    const payload = Buffer.from("test-clinical-data");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", testKey, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Tamper with ciphertext
    const tampered = Buffer.from(encrypted);
    tampered[0] ^= 0xff;

    const decipher = crypto.createDecipheriv("aes-256-gcm", testKey, iv);
    decipher.setAuthTag(authTag);

    expect(() => {
      Buffer.concat([decipher.update(tampered), decipher.final()]);
    }).toThrow();
  });
});

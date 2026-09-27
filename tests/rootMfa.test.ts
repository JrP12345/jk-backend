import { afterEach, describe, expect, it, vi } from "vitest";
import speakeasy from "speakeasy";
import crypto from "node:crypto";
import app from "../index.ts";
import { User } from "../models/User.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { encrypt, decrypt, isEncrypted } from "../utilities/encryption.ts";
import { generateTwoFactorChallenge } from "../utilities/helpers.ts";

afterEach(() => vi.unstubAllEnvs());

function legacyEncrypt(secret: string, raw: string): string {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : crypto.createHash("sha256").update(raw).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

describe("Root authenticator production verification", () => {
  it.each(["00".repeat(32), "test-only-legacy-passphrase"])("reads historical secrets using the original key derivation (%#)", (raw) => {
    vi.stubEnv("ENCRYPTION_KEY", raw);
    vi.stubEnv("DATA_ENCRYPTION_KEY", "test-only-new-primary-key");
    const secret = "JBSWY3DPEHPK3PXP";
    const legacy = legacyEncrypt(secret, raw);
    expect(isEncrypted(legacy)).toBe(true);
    expect(decrypt(legacy)).toBe(secret);
    vi.stubEnv("ENCRYPTION_KEY", "test-only-wrong-key");
    expect(decrypt(legacy)).toBe("[DECRYPTION_FAILED]");
    vi.stubEnv("ENCRYPTION_KEY", "");
    expect(decrypt(legacy)).toBe("[DECRYPTION_FAILED]");
  });

  it("completes production login for a root with a pre-SEC-003 secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENCRYPTION_KEY", "00".repeat(32));
    const { base32 } = TwoFactorService.generateSecret("root@example.invalid");
    const stored = legacyEncrypt(base32, process.env.ENCRYPTION_KEY!);
    const user = await User.create({ name: "Legacy MFA root", role: "root", twoFactorEnabled: true, twoFactorSecret: stored });
    const response = await app.inject({ remoteAddress: "192.0.2.20", method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: generateTwoFactorChallenge(user.id), otp: speakeasy.totp({ secret: base32, encoding: "base32" }),
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["set-cookie"]).toBeDefined();
    const parts = stored.split(":");
    parts[1] = (parts[1].startsWith("00") ? "ff" : "00") + parts[1].slice(2);
    await User.updateOne({ _id: user._id }, { twoFactorSecret: parts.join(":") });
    const failed = await app.inject({ remoteAddress: "192.0.2.20", method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: generateTwoFactorChallenge(user.id), otp: "123456",
    } });
    expect(failed.statusCode).toBe(500);
    expect(failed.headers["set-cookie"]).toBeUndefined();
  });
  it("provisions the same secret for QR and manual entry and verifies a real authenticator code", () => {
    vi.stubEnv("NODE_ENV", "production");
    const generated = TwoFactorService.generateSecret("root@example.invalid");
    expect(new URL(generated.otpauthUrl!).searchParams.get("secret")).toBe(generated.base32);
    const otp = speakeasy.totp({ secret: generated.base32, encoding: "base32" });
    expect(TwoFactorService.verifyToken(generated.base32, otp)).toBe(true);
    expect(TwoFactorService.verifyToken("[DECRYPTION_FAILED]", otp)).toBe(false);
    expect(TwoFactorService.verifyToken(generated.base32, "12345")).toBe(false);
  });

  it("completes root login with a genuine encrypted-secret code in production mode", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { base32 } = TwoFactorService.generateSecret("root@example.invalid");
    const user = await User.create({ name: "MFA root", role: "root", twoFactorEnabled: true, twoFactorSecret: encrypt(base32) });
    const response = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: generateTwoFactorChallenge(user.id), otp: speakeasy.totp({ secret: base32, encoding: "base32" }),
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.user.role).toBe("root");
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("reports unreadable ciphertext as a configuration failure, without issuing a session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const encrypted = encrypt(TwoFactorService.generateSecret("root@example.invalid").base32);
    const corrupted = encrypted.slice(0, -2) + (encrypted.endsWith("00") ? "ff" : "00");
    const user = await User.create({ name: "Unreadable MFA root", role: "root", twoFactorEnabled: true, twoFactorSecret: corrupted });
    const response = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: generateTwoFactorChallenge(user.id), otp: "123456",
    } });
    expect(response.statusCode).toBe(500);
    expect(response.json().message).toContain("configuration could not be read");
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(corrupted);
  });

  it("rejects a code from an obsolete secret and the development shortcut in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { base32 } = TwoFactorService.generateSecret("root@example.invalid");
    const stale = TwoFactorService.generateSecret("old-root@example.invalid").base32;
    const user = await User.create({ name: "Rotated MFA root", role: "root", twoFactorEnabled: true, twoFactorSecret: encrypt(base32) });
    for (const otp of ["123456", speakeasy.totp({ secret: stale, encoding: "base32" })]) {
      // Avoid the rare accidental match between independent six-digit tokens.
      if (TwoFactorService.verifyToken(base32, otp)) continue;
      const response = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: { twoFactorToken: generateTwoFactorChallenge(user.id), otp } });
      expect(response.statusCode).toBe(401);
      expect(response.json().message).toBe("Invalid two-factor code");
      expect(response.headers["set-cookie"]).toBeUndefined();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import speakeasy from "speakeasy";
import app from "../index.ts";
import { User } from "../models/User.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { encryptField, decryptField, isEncrypted } from "../utilities/cryptoEnvelope.ts";
import { generateTwoFactorChallenge } from "../utilities/helpers.ts";

afterEach(() => vi.unstubAllEnvs());

describe("Root authenticator production verification", () => {
  it("refuses plaintext MFA secrets without issuing a session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { base32 } = TwoFactorService.generateSecret("unencrypted@example.invalid");
    const user = await User.create({ name: "Unencrypted root", role: "root", twoFactorEnabled: true, twoFactorSecret: base32 });
    const response = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: generateTwoFactorChallenge(user.id), otp: speakeasy.totp({ secret: base32, encoding: "base32" }),
    } });
    expect(response.statusCode).toBe(500);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.body).not.toContain(base32);
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
    const user = await User.create({ name: "MFA root", role: "root", twoFactorEnabled: true, twoFactorSecret: encryptField(base32) });
    const response = await app.inject({ method: "POST", url: "/api/auth/login/verify-2fa", payload: {
      twoFactorToken: generateTwoFactorChallenge(user.id), otp: speakeasy.totp({ secret: base32, encoding: "base32" }),
    } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.user.role).toBe("root");
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("reports unreadable ciphertext as a configuration failure, without issuing a session", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const encrypted = encryptField(TwoFactorService.generateSecret("root@example.invalid").base32);
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
    const user = await User.create({ name: "Rotated MFA root", role: "root", twoFactorEnabled: true, twoFactorSecret: encryptField(base32) });
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

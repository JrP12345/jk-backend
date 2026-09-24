import { describe, it, expect, beforeAll } from "vitest";
import { app } from "../index.ts";
import { User } from "../models/User.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { encrypt, decrypt, isEncrypted } from "../utilities/encryption.ts";
import { createRefreshToken } from "../utilities/helpers.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import speakeasy from "speakeasy";

describe("Production Security Hardening Tests", () => {
  it("encrypts 2FA TOTP secret at rest and decrypts accurately during verification", () => {
    const rawSecret = "JBSWY3DPEHPK3PXP";
    const encrypted = encrypt(rawSecret);

    expect(isEncrypted(encrypted)).toBe(true);
    expect(encrypted).not.toBe(rawSecret);
    expect(encrypted.startsWith("enc:v1:")).toBe(true);

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(rawSecret);

    // Verify TOTP generation and validation with decrypted secret
    const otp = speakeasy.totp({ secret: decrypted, encoding: "base32" });
    const isValid = TwoFactorService.verifyToken(decrypted, otp);
    expect(isValid).toBe(true);
  });

  it("blocks CSRF attacks on cookie-authenticated POST endpoints with invalid origin", async () => {
    // Make request simulating an attacker-controlled origin with cookies present
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "https://malicious-attacker-site.com",
        cookie: "access_token=dummy_access_token; refresh_token=dummy_refresh_token",
      },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toContain("CSRF");
  });

  it("allows cookie-authenticated POST endpoints from mobile devices on local network / LAN", async () => {
    // Mobile device connecting via LAN IP on port 3000
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "http://10.109.193.146:3000",
        cookie: "access_token=dummy_access_token; refresh_token=dummy_refresh_token",
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("allows cookie-authenticated requests proxied with X-Forwarded-Host", async () => {
    // Mobile request proxied through Next.js rewrite with X-Forwarded-Host
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        origin: "http://192.168.1.150:3000",
        "x-forwarded-host": "192.168.1.150:3000",
        cookie: "access_token=dummy_access_token; refresh_token=dummy_refresh_token",
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("allows safe read-only GET requests regardless of origin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: {
        origin: "https://some-external-site.com",
      },
    });

    expect(res.statusCode).toBe(200);
  });

  it("rotates refresh token upon refresh and invalidates the previous token", async () => {
    const user = await User.create({
      name: "Security Test User",
      email: `sectest_${Date.now()}@ananta.health`,
      role: "admin",
      isActive: true,
    });

    // 1. Create initial refresh token
    const initialRawToken = await createRefreshToken(user.id);

    // 2. Call /api/auth/refresh with the initial token cookie
    const refreshRes = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: {
        cookie: `refresh_token=${initialRawToken}`,
        origin: "http://localhost:3000",
      },
    });

    expect(refreshRes.statusCode).toBe(200);

    // Extract new refresh_token cookie from set-cookie header
    const cookies = refreshRes.cookies;
    const newRefreshCookie = cookies.find((c) => c.name === "refresh_token");
    expect(newRefreshCookie).toBeDefined();
    expect(newRefreshCookie?.value).not.toBe(initialRawToken);

    // 3. Attempting to use the OLD (initial) token again must be detected as reuse and rejected
    // Expire the concurrency grace window to test reuse outside the grace window
    await RefreshToken.updateMany({ userId: user._id, revoked: true }, { graceExpiresAt: new Date(Date.now() - 1000) });

    const reuseRes = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      headers: {
        cookie: `refresh_token=${initialRawToken}`,
        origin: "http://localhost:3000",
      },
    });

    expect(reuseRes.statusCode).toBe(401);
    const reuseBody = JSON.parse(reuseRes.body);
    expect(reuseBody.message).toContain("reuse detected");
  });
});

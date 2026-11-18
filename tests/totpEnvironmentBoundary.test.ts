import { afterEach, expect, it, vi } from "vitest";
import speakeasy from "speakeasy";
import { TwoFactorService } from "../services/TwoFactorService.ts";

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each(["development", "test", "production"])("requires a genuine authenticator code in %s", environment => {
  vi.stubEnv("NODE_ENV", environment); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  const secret = "JBSWY3DPEHPK3PXP";
  const token = speakeasy.totp({ secret, encoding: "base32" });
  expect(token).not.toBe("123456"); expect(TwoFactorService.verifyToken(secret, token)).toBe(true);
  expect(TwoFactorService.verifyToken(secret, "123456")).toBe(false);
  expect(TwoFactorService.verifyToken("[DECRYPTION_FAILED]", token)).toBe(false);
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { abdmService } from "../services/AbdmService.ts";
afterEach(() => vi.unstubAllEnvs());
describe("ABDM sandbox boundary", () => {
  it("refuses simulated enrollment, verification and lookup in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(abdmService.generateAadhaarOtp("123456789012")).rejects.toMatchObject({ statusCode: 503 });
    await expect(abdmService.verifyAadhaarOtp("sandbox", "123456")).rejects.toMatchObject({ statusCode: 503 });
    await expect(abdmService.searchAbha("sandbox@abdm")).rejects.toMatchObject({ statusCode: 503 });
  });
});

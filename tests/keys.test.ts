import { describe, it, expect } from "vitest";
import { SERVICE_PRIVATE_KEY, SERVICE_PUBLIC_KEY, getJwks, KEY_ID } from "../utilities/keys.ts";

describe("JWKS & Service Keys Unit Tests", () => {
  it("should export valid PEM service keys", () => {
    expect(SERVICE_PRIVATE_KEY).toBeDefined();
    expect(SERVICE_PUBLIC_KEY).toBeDefined();
    expect(SERVICE_PRIVATE_KEY).toContain("BEGIN PRIVATE KEY");
    expect(SERVICE_PUBLIC_KEY).toContain("BEGIN PUBLIC KEY");
  });

  it("should generate a valid JWK Set with correct key ID and parameters", () => {
    const jwks = getJwks();
    expect(jwks).toBeDefined();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBe(1);

    const key = jwks.keys[0] as Record<string, any>;
    expect(key.kid).toBe(KEY_ID);
    expect(key.use).toBe("sig");
    expect(key.alg).toBe("RS256");
    expect(key.kty).toBe("RSA");
    expect(key.n).toBeDefined();
    expect(key.e).toBeDefined();
  });
});

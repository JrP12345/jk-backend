import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import {
  SERVICE_PRIVATE_KEY,
  SERVICE_PUBLIC_KEY,
  getJwks,
  KEY_ID,
  initKeys,
  hasConfiguredKeys,
} from "../utilities/keys.ts";
import { generateAccessToken, verifyAccessToken } from "../utilities/helpers.ts";

describe("JWKS & Service Keys Unit Tests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset env modifications before each test
    delete process.env.JWT_PRIVATE_KEY_BASE64;
    delete process.env.JWT_PUBLIC_KEY_BASE64;
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    initKeys(true);
  });

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

  it("should load keys from Base64 environment variables", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    process.env.JWT_PRIVATE_KEY_BASE64 = Buffer.from(privateKey).toString("base64");
    process.env.JWT_PUBLIC_KEY_BASE64 = Buffer.from(publicKey).toString("base64");

    const loaded = initKeys(true);
    expect(loaded.privateKey).toBe(privateKey);
    expect(loaded.publicKey).toBe(publicKey);
    expect(hasConfiguredKeys()).toBe(true);
  });

  it("should load keys from escaped PEM environment variables", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    process.env.JWT_PRIVATE_KEY = privateKey.replace(/\n/g, "\\n");
    process.env.JWT_PUBLIC_KEY = publicKey.replace(/\n/g, "\\n");

    const loaded = initKeys(true);
    expect(loaded.privateKey.trim()).toBe(privateKey.trim());
    expect(loaded.publicKey.trim()).toBe(publicKey.trim());
    expect(hasConfiguredKeys()).toBe(true);
  });

  it("should throw a fatal configuration error in production when keys are missing and no files exist", () => {
    process.env.NODE_ENV = "production";
    process.env.JWT_PRIVATE_KEY_PATH = "/non/existent/private.pem";
    process.env.JWT_PUBLIC_KEY_PATH = "/non/existent/public.pem";

    expect(() => initKeys(true)).toThrowError(/FATAL SECURITY CONFIGURATION ERROR/);
  });

  it("should successfully sign and verify RS256 JWT tokens using the configured keys", () => {
    // Ensure active keys are set
    initKeys(true);

    const payload = {
      id: "test-user-123",
      email: "doctor@healthos.dev",
      role: "doctor",
      organization_id: "org-1",
    };

    const token = generateAccessToken(payload);
    expect(token).toBeDefined();
    expect(typeof token).toBe("string");

    const decoded = verifyAccessToken(token);
    expect(decoded.id).toBe(payload.id);
    expect(decoded.email).toBe(payload.email);
    expect(decoded.role).toBe(payload.role);
    expect(decoded.organization_id).toBe(payload.organization_id);
  });
});

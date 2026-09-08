import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function getPrivateKeyPath(): string {
  return process.env.JWT_PRIVATE_KEY_PATH || path.join(process.cwd(), "keys", "private.pem");
}

export function getPublicKeyPath(): string {
  return process.env.JWT_PUBLIC_KEY_PATH || path.join(process.cwd(), "keys", "public.pem");
}

export const KEY_ID = "healthos-service-key-1";

export let SERVICE_PRIVATE_KEY: string = "";
export let SERVICE_PUBLIC_KEY: string = "";

export function getServicePrivateKey(): string {
  return SERVICE_PRIVATE_KEY;
}

export function getServicePublicKey(): string {
  return SERVICE_PUBLIC_KEY;
}

/**
 * Check if keys are provided via environment variables or existing files without triggering generation.
 */
export function hasConfiguredKeys(): boolean {
  if (process.env.JWT_PRIVATE_KEY_BASE64 && process.env.JWT_PUBLIC_KEY_BASE64) {
    return true;
  }
  if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
    return true;
  }
  const privPath = getPrivateKeyPath();
  const pubPath = getPublicKeyPath();
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    return true;
  }
  return false;
}

/**
 * Initialize RS256 service keys.
 * In production, ephemeral key generation is strictly forbidden to prevent
 * cross-pod verification failure and token invalidation on container restart.
 */
export function initKeys(forceReload = false): { privateKey: string; publicKey: string } {
  if (!forceReload && SERVICE_PRIVATE_KEY && SERVICE_PUBLIC_KEY) {
    return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
  }

  // 1. Check Base64 environment variables (ideal for K8s secrets / cloud secret managers / Docker)
  if (process.env.JWT_PRIVATE_KEY_BASE64 && process.env.JWT_PUBLIC_KEY_BASE64) {
    try {
      SERVICE_PRIVATE_KEY = Buffer.from(process.env.JWT_PRIVATE_KEY_BASE64.trim(), "base64").toString("utf8");
      SERVICE_PUBLIC_KEY = Buffer.from(process.env.JWT_PUBLIC_KEY_BASE64.trim(), "base64").toString("utf8");
      return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
    } catch (err: any) {
      throw new Error(`Failed to decode JWT_*_BASE64 environment variables: ${err?.message || err}`);
    }
  }

  // 2. Check raw PEM environment variables
  if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
    SERVICE_PRIVATE_KEY = process.env.JWT_PRIVATE_KEY.replace(/\\n/g, "\n").trim();
    SERVICE_PUBLIC_KEY = process.env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n").trim();
    return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
  }

  // 3. Check persistent or volume-mounted filesystem keys
  const privPath = getPrivateKeyPath();
  const pubPath = getPublicKeyPath();
  if (fs.existsSync(privPath) && fs.existsSync(pubPath)) {
    SERVICE_PRIVATE_KEY = fs.readFileSync(privPath, "utf8").trim();
    SERVICE_PUBLIC_KEY = fs.readFileSync(pubPath, "utf8").trim();
    return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
  }

  // 4. In production, fail immediately — NEVER generate ephemeral keys on boot!
  const isProd = process.env.NODE_ENV === "production";
  if (isProd) {
    throw new Error(
      "❌ [FATAL SECURITY CONFIGURATION ERROR]\n" +
      "RS256 JWT keypair is not configured in production mode.\n" +
      "Generating ephemeral keys on boot breaks horizontal scaling (Pod A cannot verify Pod B's tokens)\n" +
      "and will log out all active users whenever a container restarts or rolls out.\n\n" +
      "Fix: Generate a persistent keypair once using `npm run generate:keys` and inject into your cluster:\n" +
      "  - JWT_PRIVATE_KEY_BASE64 & JWT_PUBLIC_KEY_BASE64 (recommended for K8s Secret / AWS Secrets Manager / Doppler)\n" +
      "  - OR JWT_PRIVATE_KEY & JWT_PUBLIC_KEY\n" +
      `  - OR mount keys at ${privPath} and ${pubPath}\n`
    );
  }

  // 5. Development/Test fallback: auto-generate keypair if not present
  const keysDir = path.dirname(privPath);
  if (!fs.existsSync(keysDir)) {
    try {
      fs.mkdirSync(keysDir, { recursive: true });
    } catch {
      // Ignore if directory cannot be created
    }
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  try {
    fs.writeFileSync(privPath, privateKey, "utf8");
    fs.writeFileSync(pubPath, publicKey, "utf8");
  } catch {
    // Read-only filesystem in some container tests; keep in-memory
  }

  SERVICE_PRIVATE_KEY = privateKey;
  SERVICE_PUBLIC_KEY = publicKey;

  return { privateKey: SERVICE_PRIVATE_KEY, publicKey: SERVICE_PUBLIC_KEY };
}

// Initial invocation
initKeys();

/**
 * Return the public key formatted as a JWK Set (JWKS).
 */
export function getJwks(): { keys: Array<Record<string, any>> } {
  const keyObj = crypto.createPublicKey(SERVICE_PUBLIC_KEY);
  const jwk = keyObj.export({ format: "jwk" }) as Record<string, any>;

  return {
    keys: [
      {
        ...jwk,
        kid: KEY_ID,
        use: "sig",
        alg: "RS256",
      },
    ],
  };
}

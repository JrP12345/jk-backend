import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEYS_DIR = path.join(process.cwd(), "keys");
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, "private.pem");
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, "public.pem");

export const KEY_ID = "healthos-service-key-1";

let privateKeyPem = "";
let publicKeyPem = "";

function initKeys() {
  if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
    privateKeyPem = process.env.JWT_PRIVATE_KEY.replace(/\\n/g, "\n");
    publicKeyPem = process.env.JWT_PUBLIC_KEY.replace(/\\n/g, "\n");
    return;
  }

  if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
    privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, "utf8");
    publicKeyPem = fs.readFileSync(PUBLIC_KEY_PATH, "utf8");
    return;
  }

  // Auto-generate service keypair for dev/test if files don't exist
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, "utf8");
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, "utf8");

  privateKeyPem = privateKey;
  publicKeyPem = publicKey;
}

initKeys();

export const SERVICE_PRIVATE_KEY: string = privateKeyPem;
export const SERVICE_PUBLIC_KEY: string = publicKeyPem;

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

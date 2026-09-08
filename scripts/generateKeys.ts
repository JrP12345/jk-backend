#!/usr/bin/env node
/**
 * Production RS256 Keypair Generator for HealthOS
 *
 * Generates an RSA-2048 keypair suitable for RS256 JWT signing and verification.
 * Outputs both Base64-encoded strings (recommended for K8s / Cloud Secret Managers)
 * and escaped PEM strings.
 *
 * Usage:
 *   node --experimental-strip-types scripts/generateKeys.ts [options]
 *
 * Options:
 *   --write, -w       Write PEM files directly to ./keys/private.pem and ./keys/public.pem
 *   --append-env, -e  Append the generated JWT_*_BASE64 variables to your local .env
 *   --k8s             Output Kubernetes Secret manifest
 *   --json            Output as raw JSON
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function generateKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const privateKeyBase64 = Buffer.from(privateKey).toString("base64");
  const publicKeyBase64 = Buffer.from(publicKey).toString("base64");
  const privateKeyEscaped = privateKey.replace(/\r?\n/g, "\\n");
  const publicKeyEscaped = publicKey.replace(/\r?\n/g, "\\n");

  return {
    privateKey,
    publicKey,
    privateKeyBase64,
    publicKeyBase64,
    privateKeyEscaped,
    publicKeyEscaped,
  };
}

function main() {
  const args = process.argv.slice(2);
  const shouldWrite = args.includes("--write") || args.includes("-w");
  const shouldAppendEnv = args.includes("--append-env") || args.includes("-e");
  const outputK8s = args.includes("--k8s");
  const outputJson = args.includes("--json");

  const keys = generateKeys();

  if (outputJson) {
    console.log(JSON.stringify(keys, null, 2));
    return;
  }

  if (outputK8s) {
    const k8sSecretYaml = `apiVersion: v1
kind: Secret
metadata:
  name: healthos-jwt-keys
  namespace: default
type: Opaque
data:
  JWT_PRIVATE_KEY_BASE64: ${keys.privateKeyBase64}
  JWT_PUBLIC_KEY_BASE64: ${keys.publicKeyBase64}
`;
    console.log(k8sSecretYaml);
    return;
  }

  console.log("================================================================================");
  console.log("             HealthOS Production RS256 JWT Keypair Generated                  ");
  console.log("================================================================================");
  console.log("\n🔑 [OPTION 1] BASE64 ENCODED (Recommended for Docker, K8s, AWS Secrets Manager, Doppler):");
  console.log("--------------------------------------------------------------------------------");
  console.log(`JWT_PRIVATE_KEY_BASE64="${keys.privateKeyBase64}"`);
  console.log(`JWT_PUBLIC_KEY_BASE64="${keys.publicKeyBase64}"`);

  console.log("\n📄 [OPTION 2] ESCAPED PEM FORMAT (Single-line for standard .env):");
  console.log("--------------------------------------------------------------------------------");
  console.log(`JWT_PRIVATE_KEY="${keys.privateKeyEscaped}"`);
  console.log(`JWT_PUBLIC_KEY="${keys.publicKeyEscaped}"`);

  if (shouldWrite) {
    const keysDir = path.join(process.cwd(), "keys");
    if (!fs.existsSync(keysDir)) {
      fs.mkdirSync(keysDir, { recursive: true });
    }
    const privPath = path.join(keysDir, "private.pem");
    const pubPath = path.join(keysDir, "public.pem");
    fs.writeFileSync(privPath, keys.privateKey, "utf8");
    fs.writeFileSync(pubPath, keys.publicKey, "utf8");
    console.log(`\n💾 Written PEM keys directly to:\n  - ${privPath}\n  - ${pubPath}`);
  }

  if (shouldAppendEnv) {
    const envPath = path.join(process.cwd(), ".env");
    const snippet = `\n# RS256 JWT Keys (Generated ${new Date().toISOString()})\nJWT_PRIVATE_KEY_BASE64="${keys.privateKeyBase64}"\nJWT_PUBLIC_KEY_BASE64="${keys.publicKeyBase64}"\n`;
    fs.appendFileSync(envPath, snippet, "utf8");
    console.log(`\n📝 Appended JWT_*_BASE64 keys to ${envPath}`);
  }

  console.log("\n📌 Deployment Instructions:");
  console.log("  • Multi-Replica Kubernetes: Set these as environment variables from a Secret.");
  console.log("    Run with '--k8s' to print a ready-to-apply Kubernetes Secret manifest.");
  console.log("  • Docker Compose: Add JWT_PRIVATE_KEY_BASE64 & JWT_PUBLIC_KEY_BASE64 to your compose env.");
  console.log("  • All pods in the cluster will share this keypair, ensuring seamless horizontal scaling.");
  console.log("================================================================================\n");
}

main();

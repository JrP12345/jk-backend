import fs from "node:fs";
import path from "node:path";

const baseRequiredEnv = [
  "MONGODB_URI",
];

const productionRequiredEnv = [
  "MONGODB_URI",
  "CORS_ALLOWED_ORIGINS",
];

export function getFrontendBaseUrl(): string {
  if (process.env.APP_URL) {
    return process.env.APP_URL.trim().replace(/\/+$/, "");
  }
  if (process.env.FRONTEND_URL) {
    return process.env.FRONTEND_URL.trim().replace(/\/+$/, "");
  }
  if (process.env.CORS_ALLOWED_ORIGINS) {
    const firstOrigin = process.env.CORS_ALLOWED_ORIGINS.split(",")[0].trim().replace(/\/+$/, "");
    if (firstOrigin) return firstOrigin;
  }
  return "http://localhost:3000";
}

export function verifyEnv() {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  
  const isProd = process.env.NODE_ENV === "production";
  const checkList = isProd ? productionRequiredEnv : baseRequiredEnv;
  const missing: string[] = [];

  for (const envName of checkList) {
    if (!process.env[envName]) {
      missing.push(envName);
    }
  }

  if (isProd) {
    const hasBase64Keys = !!(process.env.JWT_PRIVATE_KEY_BASE64 && process.env.JWT_PUBLIC_KEY_BASE64);
    const hasPemKeys = !!(process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY);
    const keysDir = path.join(process.cwd(), "keys");
    const privatePath = process.env.JWT_PRIVATE_KEY_PATH || path.join(keysDir, "private.pem");
    const publicPath = process.env.JWT_PUBLIC_KEY_PATH || path.join(keysDir, "public.pem");
    const hasKeyFiles = fs.existsSync(privatePath) && fs.existsSync(publicPath);

    if (!hasBase64Keys && !hasPemKeys && !hasKeyFiles) {
      missing.push("JWT_PRIVATE_KEY_BASE64 & JWT_PUBLIC_KEY_BASE64 (or JWT_PRIVATE_KEY & JWT_PUBLIC_KEY) - run 'npm run generate:keys'");
    } else if (hasKeyFiles && !hasBase64Keys && !hasPemKeys) {
      console.warn("⚠️ [Security Warning] Production is using filesystem-based JWT keys. For multi-replica cluster/K8s deployments, configure JWT_PRIVATE_KEY_BASE64 and JWT_PUBLIC_KEY_BASE64 as environment variables or K8s Secrets so all pods share identical keys.");
    }

    // Fail loud if Redis is missing in production (required for multi-replica WebSocket PubSub and cross-pod panic alerts)
    if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
      if (process.env.ALLOW_SINGLE_NODE_IN_PRODUCTION === "true") {
        console.warn("⚠️ [Security & Scalability Warning] Production is running without Redis (ALLOW_SINGLE_NODE_IN_PRODUCTION=true). Multi-node WebSocket fan-out, cross-pod panic alerts, and distributed rate limiting are DISABLED.");
      } else {
        missing.push("REDIS_URL or REDIS_HOST (Required in production for multi-replica WebSocket PubSub fan-out and panic alert delivery; set ALLOW_SINGLE_NODE_IN_PRODUCTION=true to explicitly allow single-node deploys)");
      }
    }

    // Validate MONGODB_URI has replica set configuration for ACID multi-document transactions in production
    const mongoUri = process.env.MONGODB_URI || "";
    const isReplicaSetUri =
      mongoUri.startsWith("mongodb+srv://") ||
      mongoUri.includes("replicaSet=") ||
      (mongoUri.startsWith("mongodb://") && mongoUri.split("?")[0].includes(","));

    if (!isReplicaSetUri && process.env.ALLOW_STANDALONE_IN_PRODUCTION !== "true") {
      missing.push(
        "MONGODB_URI must specify a Replica Set (mongodb+srv:// or ?replicaSet=... or multiple comma-separated seed hosts) in production mode to ensure multi-document ACID transactions. Set ALLOW_STANDALONE_IN_PRODUCTION=true to explicitly override for testing."
      );
    }

    // Require webhook HMAC secret for UPI/Razorpay callbacks in production
    if (!process.env.UPI_WEBHOOK_SECRET && !process.env.RAZORPAY_WEBHOOK_SECRET) {
      missing.push(
        "UPI_WEBHOOK_SECRET or RAZORPAY_WEBHOOK_SECRET (Required in production to verify payment callbacks)"
      );
    }
  }

  // Validate DATA_ENCRYPTION_KEY / ENCRYPTION_KEY (SEC-003)
  const encryptionKey = process.env.DATA_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY || process.env.APP_ENCRYPTION_KEY;
  if (!encryptionKey) {
    if (isProd) {
      missing.push("DATA_ENCRYPTION_KEY (Required in production for field-level encryption of PHI and secrets)");
    } else {
      console.warn("⚠️ [Security Notice] Neither DATA_ENCRYPTION_KEY nor ENCRYPTION_KEY is set. Using dev fallback key.");
    }
  } else {
    if (!process.env.DATA_ENCRYPTION_KEY) {
      console.warn("⚠️ [Security Notice] Using legacy ENCRYPTION_KEY/APP_ENCRYPTION_KEY. Please migrate to DATA_ENCRYPTION_KEY.");
    }
    if (encryptionKey.length !== 64 && encryptionKey.length < 32) {
      if (isProd) {
        missing.push("DATA_ENCRYPTION_KEY must be at least 32 characters (or a 64-char hex string)");
      } else {
        console.warn("⚠️ [Security Warning] Encryption key is shorter than 32 characters. Recommended: 64-char hex string.");
      }
    }
  }

  if (missing.length > 0) {
    console.error("❌ Fatal Configuration Error: Missing required environment variables:");
    for (const name of missing) {
      console.error(`   - ${name}`);
    }
    process.exit(1);
  }

  if (isProd) {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.warn("⚠️ [Config Warning] Outbound SMTP credentials are not fully configured in backend .env. Emails will rely on per-organization SMTP settings.");
    }
  }
}

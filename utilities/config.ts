const baseRequiredEnv = [
  "MONGODB_URI",
  "ENCRYPTION_KEY",
];

const productionRequiredEnv = [
  "MONGODB_URI",
  "ENCRYPTION_KEY",
  "CORS_ALLOWED_ORIGINS",
];

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

  // Validate ENCRYPTION_KEY length if provided
  if (process.env.ENCRYPTION_KEY) {
    const key = process.env.ENCRYPTION_KEY;
    if (key.length !== 64 && key.length < 32) {
      console.warn("⚠️ [Security Warning] ENCRYPTION_KEY is shorter than 32 characters. Recommended: 64-char hex string.");
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
    if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
      console.warn("⚠️ [Config Warning] Redis is not configured. Multi-node cluster rate-limiting and SSE synchronization will use in-memory fallback.");
    }
  }
}

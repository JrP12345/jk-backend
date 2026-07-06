const requiredEnv = [
  "MONGODB_URI",
  "JWT_SECRET",
  "CLOUDFLARE_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET_NAME"
];

export function verifyEnv() {
  if (process.env.NODE_ENV === "test") {
    return;
  }
  
  const missing: string[] = [];
  for (const envName of requiredEnv) {
    if (!process.env[envName]) {
      missing.push(envName);
    }
  }

  if (missing.length > 0) {
    console.error("❌ Fatal Configuration Error: Missing required environment variables:");
    for (const name of missing) {
      console.error(`   - ${name}`);
    }
    process.exit(1);
  }
}

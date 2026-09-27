import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { decrypt, isEncrypted } from "../utilities/encryption.ts";

class RootMfaCheckError extends Error {}

/** Read-only: use the same database and environment as the deployed backend. */
async function checkRootTwoFactor(): Promise<void> {
  if (!process.env.MONGODB_URI) throw new RootMfaCheckError("MONGODB_URI is required; no local fallback is used.");
  if (!process.env.DATA_ENCRYPTION_KEY && !process.env.ENCRYPTION_KEY && !process.env.APP_ENCRYPTION_KEY) {
    throw new RootMfaCheckError("The backend's data encryption key must be configured before checking MFA.");
  }
  const email = process.env.ROOT_ADMIN_EMAIL?.trim().toLowerCase();
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000, socketTimeoutMS: 30_000 });
  const users = await User.find({ role: "root", isActive: true, ...(email ? { email } : {}) })
    .select("twoFactorEnabled twoFactorSecret").limit(2).lean();
  if (users.length === 0) throw new RootMfaCheckError("No matching active root account exists in this database.");
  if (users.length > 1) throw new RootMfaCheckError("Multiple root accounts exist. Set ROOT_ADMIN_EMAIL to choose one.");
  const user = users[0];
  if (!user.twoFactorEnabled || !user.twoFactorSecret) throw new RootMfaCheckError("MFA is not configured for this root account.");
  const encrypted = isEncrypted(user.twoFactorSecret);
  const secret = encrypted ? decrypt(user.twoFactorSecret) : user.twoFactorSecret;
  if (secret === "[DECRYPTION_FAILED]") {
    throw new RootMfaCheckError("MFA_SECRET_DECRYPTION_FAILED: the saved secret cannot be decrypted with this environment's effective encryption key. Restore the original key or investigate ciphertext integrity; changing keys again will not recover it.");
  }
  if (!TwoFactorService.normalizeSecret(secret)) throw new RootMfaCheckError("MFA_SECRET_FORMAT_INVALID: the saved value is not a usable base32 authenticator secret.");
  const keySource = process.env.DATA_ENCRYPTION_KEY ? "DATA_ENCRYPTION_KEY" : process.env.ENCRYPTION_KEY ? "ENCRYPTION_KEY" : "APP_ENCRYPTION_KEY";
  console.log(`MFA_CONFIG_READABLE: active root account found; ${encrypted ? "encrypted" : "legacy plaintext"} secret is readable. Effective key variable: ${keySource}.`);
  console.log(`Server UTC: ${new Date().toISOString()}. TOTP period: 30 seconds; configured drift tolerance: +/-180 seconds.`);
  console.log("This check does not compare your phone's secret. If codes still fail, check device time, the selected authenticator entry, prior resets and whether the deployed service uses this same database/environment.");
  console.log("No account, MFA secret or session was changed; no OTP or secret was printed.");
}

checkRootTwoFactor().catch(error => {
  // Do not echo MongoDB connection errors: they can contain connection details.
  console.error(error instanceof RootMfaCheckError ? error.message : "MFA check failed while reading the configuration or MongoDB. Check service logs, connectivity and credentials.");
  process.exitCode = 1;
}).finally(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

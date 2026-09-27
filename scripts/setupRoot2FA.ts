import mongoose from "mongoose";
import QRCode from "qrcode";
import { mkdir, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { User } from "../models/User.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { encrypt } from "../utilities/encryption.ts";

/**
 * Generates a replacement TOTP secret for one platform-root account.
 *
 * This script intentionally requires MONGODB_URI. Falling back to a local
 * database made it possible to provision an authenticator against a secret
 * that the deployed application never reads.
 */
const mongodbUri = process.env.MONGODB_URI;
const rootEmail = (process.env.ROOT_ADMIN_EMAIL || "21amtics177@gmail.com").trim().toLowerCase();
const isProduction = process.env.NODE_ENV === "production";

async function setupRootTwoFactor(): Promise<void> {
  if (!mongodbUri) {
    throw new Error("MONGODB_URI is required. Refusing to configure 2FA against an implicit local database.");
  }

  if (!process.env.DATA_ENCRYPTION_KEY && !process.env.ENCRYPTION_KEY && !process.env.APP_ENCRYPTION_KEY) {
    throw new Error("DATA_ENCRYPTION_KEY, ENCRYPTION_KEY or APP_ENCRYPTION_KEY is required so the root 2FA secret can be stored encrypted.");
  }

  if (isProduction && process.env.ROOT_2FA_CONFIRM !== "RESET") {
    throw new Error("Set ROOT_2FA_CONFIRM=RESET to rotate a production root 2FA secret.");
  }

  console.log("Connecting to the configured MongoDB instance...");
  await mongoose.connect(mongodbUri, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
  });
  console.log("MongoDB connected. Locating the active root account...");

  const user = await User.findOne({ email: rootEmail, role: "root", isActive: true });
  if (!user) {
    throw new Error(`No active root user was found for ${rootEmail}.`);
  }

  const secret = TwoFactorService.generateSecret(user.email || rootEmail, "Ekavyu");
  if (!secret.base32 || !secret.otpauthUrl) {
    throw new Error("Could not generate a TOTP secret.");
  }

  // Prepare the enrollment artifact before changing the saved secret.
  const qrPath = process.env.ROOT_2FA_QR_PATH ? path.resolve(process.env.ROOT_2FA_QR_PATH) : undefined;
  const qrTerminal = qrPath ? undefined : await QRCode.toString(secret.otpauthUrl, { type: "terminal", small: true });
  if (qrPath) {
    await mkdir(path.dirname(qrPath), { recursive: true });
    await QRCode.toFile(qrPath, secret.otpauthUrl, { width: 480, margin: 4 });
    await chmod(qrPath, 0o600);
  }
  try {
    // Rotating the secret invalidates every previously provisioned authenticator.
    user.twoFactorEnabled = true;
    user.twoFactorSecret = encrypt(secret.base32);
    await user.save();
  } catch (error) {
    if (qrPath) await rm(qrPath, { force: true });
    throw error;
  }
  console.log("Root MFA secret saved.");

  console.log("==========================================================");
  console.log(`ROOT 2FA RESET COMPLETE FOR ${rootEmail}`);
  console.log("==========================================================");
  console.log("Scan this QR code once with the authenticator app that will be used for this root account:\n");
  console.log(qrPath ? `Enrollment QR saved to ${qrPath}. Delete this file after scanning.` : qrTerminal);
  console.log("The replacement secret is encrypted in MongoDB. Do not retain this terminal output.");
}

setupRootTwoFactor()
  .catch((error) => {
    console.error("Root 2FA setup failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  });

import mongoose from "mongoose";
import speakeasy from "speakeasy";
import QRCode from "qrcode";
import { User } from "../models/User.ts";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/ananta_health";

async function setup2FA() {
  try {
    await mongoose.connect(MONGODB_URI);
    const email = "21amtics177@gmail.com";
    const user = await User.findOne({ email });
    if (!user) {
      console.error("Root Admin user not found!");
      process.exit(1);
    }

    const secret = speakeasy.generateSecret({
      length: 20,
      name: `ANANTA (${email})`,
      issuer: "ANANTA",
    });

    user.twoFactorEnabled = true;
    user.twoFactorSecret = secret.base32;
    await user.save();

    const qrTerminal = await QRCode.toString(secret.otpauth_url!, { type: "terminal", small: true });

    console.log("==========================================================");
    console.log("🔐 2FA SETUP FOR ROOT ADMIN (21amtics177@gmail.com)");
    console.log("==========================================================");
    console.log("Account Email      :", email);
    console.log("Secret Key (Base32):", secret.base32);
    console.log("otpauth URL        :", secret.otpauth_url);
    console.log("----------------------------------------------------------");
    console.log("Scan this QR Code with Google Authenticator / Authy app:\n");
    console.log(qrTerminal);
    console.log("==========================================================");
  } catch (err) {
    console.error("Failed to setup 2FA:", err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

setup2FA();

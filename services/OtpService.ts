import bcrypt from "bcryptjs";
import { OtpVerification } from "../models/OtpVerification.ts";
import { sendSmsWhatsAppNotification } from "./SmsWhatsAppService.ts";
import { normalizePhone } from "../utilities/helpers.ts";

export interface RequestOtpResult {
  success: boolean;
  message: string;
  phone: string;
  expiresInSeconds: number;
  devOtp?: string; // Only populated in NODE_ENV !== "production"
}

export interface VerifyOtpResult {
  success: boolean;
  message: string;
  phone: string;
  verified: boolean;
}

export class OtpService {
  /**
   * Request a 6-digit OTP for a given phone number and purpose.
   * Handles rate-limiting (max 5 requests per 10 minute window).
   */
  async requestOtp(
    rawPhone: string,
    purpose: "authentication" | "phone_verification" | "record_claim" = "authentication"
  ): Promise<RequestOtpResult> {
    const phone = this.normalizePhone(rawPhone);
    if (!phone || phone.length < 10) {
      throw new Error("Invalid phone number format");
    }

    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    // Rate Limiting Check: max 5 requests per 10 minutes
    const recentRequests = await OtpVerification.find({
      phone,
      createdAt: { $gte: tenMinutesAgo },
    });

    if (recentRequests.length >= 5) {
      throw new Error("Too many OTP requests. Please wait 10 minutes before trying again.");
    }

    // Generate 6-digit OTP
    const otpCode = process.env.NODE_ENV === "test" ? "123456" : String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = await bcrypt.hash(otpCode, 10);
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minute validity

    // Invalidate existing active OTPs for this phone/purpose without wiping rate-limit history
    await OtpVerification.updateMany(
      { phone, purpose, verified: false, expiresAt: { $gt: now } },
      { expiresAt: now }
    );

    await OtpVerification.create({
      phone,
      otpHash,
      purpose,
      expiresAt,
      attempts: 0,
      verified: false,
      requestCount: recentRequests.length + 1,
      windowStart: recentRequests[0]?.createdAt || now,
    });

    const isDev = process.env.NODE_ENV !== "production";

    if (isDev) {
      console.log(`[DEV OTP GENERATED] Phone: ${phone} | Purpose: ${purpose} | OTP: ${otpCode}`);
    } else {
      // Production SMS / WhatsApp Provider Abstraction
      sendSmsWhatsAppNotification({
        phone,
        channel: "sms",
        templateId: "OTP_VERIFICATION",
        variables: {
          otpCode,
          purpose,
        },
      }).catch((err) => console.error("OTP Delivery failed:", err));
    }

    return {
      success: true,
      message: `OTP sent to ${phone}`,
      phone,
      expiresInSeconds: 300,
      devOtp: isDev ? otpCode : undefined,
    };
  }

  /**
   * Verify 6-digit OTP code for a phone number and purpose.
   */
  async verifyOtp(
    rawPhone: string,
    otp: string,
    purpose: "authentication" | "phone_verification" | "record_claim" = "authentication"
  ): Promise<VerifyOtpResult> {
    const phone = this.normalizePhone(rawPhone);
    const cleanOtp = otp ? otp.trim() : "";

    if (!phone || !/^\d{6}$/.test(cleanOtp)) {
      return { success: false, message: "Valid 6-digit OTP is required", phone, verified: false };
    }

    const record = await OtpVerification.findOne({
      phone,
      purpose,
      verified: false,
      expiresAt: { $gt: new Date() },
    }).sort({ createdAt: -1 });

    if (!record) {
      return { success: false, message: "Expired or invalid OTP code. Please request a new code.", phone, verified: false };
    }

    if (record.attempts >= 5) {
      await OtpVerification.deleteOne({ _id: record._id });
      return { success: false, message: "Too many failed attempts. OTP invalidated. Request a new code.", phone, verified: false };
    }

    const isValid = await bcrypt.compare(cleanOtp, record.otpHash);
    if (!isValid) {
      record.attempts += 1;
      await record.save();
      return { success: false, message: `Invalid OTP code (${5 - record.attempts} attempts remaining)`, phone, verified: false };
    }

    // Mark as verified
    record.verified = true;
    await record.save();

    return { success: true, message: "OTP verified successfully", phone, verified: true };
  }

  normalizePhone(phone: string): string {
    return normalizePhone(phone);
  }
}

export const otpService = new OtpService();

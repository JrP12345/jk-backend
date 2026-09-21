import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { OtpVerification } from "../models/OtpVerification.ts";
import { sendSmsWhatsAppNotification } from "./SmsWhatsAppService.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";
import { normalizePhone } from "../utilities/helpers.ts";

export type OtpTarget = string | { phone?: string; email?: string };

export type OtpPurpose = "authentication" | "phone_verification" | "email_verification" | "record_claim";

export interface RequestOtpResult {
  success: boolean;
  message: string;
  phone?: string;
  email?: string;
  expiresInSeconds: number;
  devOtp?: string; // Only populated in NODE_ENV !== "production"
}

export interface VerifyOtpResult {
  success: boolean;
  message: string;
  phone?: string;
  email?: string;
  verified: boolean;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseTarget(target: OtpTarget): { phone?: string; email?: string } {
  if (typeof target === "string") {
    const trimmed = target.trim();
    if (trimmed.includes("@")) {
      return { email: trimmed.toLowerCase() };
    }
    return { phone: normalizePhone(trimmed) };
  }
  return {
    phone: target.phone ? normalizePhone(target.phone) : undefined,
    email: target.email ? target.email.trim().toLowerCase() : undefined,
  };
}

export class OtpService {
  /**
   * Request a 6-digit OTP for a given phone number or email address and purpose.
   * Handles rate-limiting (max 5 requests per 10 minute window).
   */
  async requestOtp(
    target: OtpTarget,
    purpose: OtpPurpose = "authentication"
  ): Promise<RequestOtpResult> {
    const { phone, email } = parseTarget(target);

    if (email) {
      if (!EMAIL_REGEX.test(email)) {
        throw new Error("Invalid email address format");
      }
    } else if (phone) {
      if (!phone || phone.length < 10) {
        throw new Error("Invalid phone number format");
      }
    } else {
      throw new Error("Mobile phone number or email address is required");
    }

    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

    // Rate Limiting Check: max 5 requests per 10 minutes
    const query = email ? { email, createdAt: { $gte: tenMinutesAgo } } : { phone, createdAt: { $gte: tenMinutesAgo } };
    const recentRequests = await OtpVerification.find(query);

    if (recentRequests.length >= 5) {
      throw new Error("Too many OTP requests. Please wait 10 minutes before trying again.");
    }

    // Generate 6-digit OTP
    const otpCode = process.env.NODE_ENV === "test" ? "123456" : String(crypto.randomInt(100000, 1_000_000));
    const otpHash = await bcrypt.hash(otpCode, 10);
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minute validity

    // Invalidate existing active OTPs for this target/purpose without wiping rate-limit history
    const activeQuery = email
      ? { email, purpose, verified: false, expiresAt: { $gt: now } }
      : { phone, purpose, verified: false, expiresAt: { $gt: now } };

    await OtpVerification.updateMany(activeQuery, { expiresAt: now });

    await OtpVerification.create({
      phone: phone || undefined,
      email: email || undefined,
      otpHash,
      purpose,
      expiresAt,
      attempts: 0,
      verified: false,
      requestCount: recentRequests.length + 1,
      windowStart: recentRequests[0]?.createdAt || now,
    });

    const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";

    if (email) {
      if (isDev) {
        console.log(`[DEV OTP GENERATED] Email: ${email} | Purpose: ${purpose} | OTP: ${otpCode}`);
      }
      emailProvider.sendEmail({
        to: email,
        subject: "ANANTA Security Verification OTP Code",
        text: `Your ANANTA verification code is: ${otpCode}. Valid for 5 minutes.`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
            <div style="margin-bottom: 20px;">
              <h2 style="color: #0f766e; margin: 0 0 8px 0; font-size: 20px;">ANANTA Healthcare</h2>
              <p style="color: #475569; font-size: 14px; margin: 0;">Security Verification Code</p>
            </div>
            <p style="color: #334155; font-size: 14px; line-height: 1.5; margin-bottom: 16px;">
              Use the one-time verification code below to sign in to your patient portal:
            </p>
            <div style="background-color: #f0fdfa; border: 1.5px dashed #0d9488; border-radius: 12px; padding: 16px; text-align: center; margin-bottom: 20px;">
              <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #0f766e; font-family: monospace;">${otpCode}</span>
            </div>
            <p style="color: #64748b; font-size: 12px; line-height: 1.5; margin: 0;">
              This code expires in <strong>5 minutes</strong>. If you did not request this sign-in code, you can safely ignore this email.
            </p>
          </div>
        `,
      }).catch((err) => console.error("Email OTP delivery failed:", err));

      return {
        success: true,
        message: `OTP sent to ${email}`,
        email,
        expiresInSeconds: 300,
        devOtp: isDev ? otpCode : undefined,
      };
    } else {
      if (isDev) {
        console.log(`[DEV OTP GENERATED] Phone: ${phone} | Purpose: ${purpose} | OTP: ${otpCode}`);
      } else {
        // Production SMS / WhatsApp Provider Abstraction
        sendSmsWhatsAppNotification({
          phone: phone!,
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
        phone: phone!,
        expiresInSeconds: 300,
        devOtp: isDev ? otpCode : undefined,
      };
    }
  }

  /**
   * Verify 6-digit OTP code for a phone number or email address and purpose.
   */
  async verifyOtp(
    target: OtpTarget,
    otp: string,
    purpose: OtpPurpose = "authentication"
  ): Promise<VerifyOtpResult> {
    const { phone, email } = parseTarget(target);
    const cleanOtp = otp ? otp.trim() : "";

    if ((!phone && !email) || !/^\d{6}$/.test(cleanOtp)) {
      return { success: false, message: "Valid 6-digit OTP is required", phone, email, verified: false };
    }

    const query = email
      ? { email, purpose, verified: false, expiresAt: { $gt: new Date() } }
      : { phone, purpose, verified: false, expiresAt: { $gt: new Date() } };

    const record = await OtpVerification.findOne(query).sort({ createdAt: -1 });

    if (!record) {
      return { success: false, message: "Expired or invalid OTP code. Please request a new code.", phone, email, verified: false };
    }

    if (record.attempts >= 5) {
      await OtpVerification.deleteOne({ _id: record._id });
      return { success: false, message: "Too many failed attempts. OTP invalidated. Request a new code.", phone, email, verified: false };
    }

    const isValid = await bcrypt.compare(cleanOtp, record.otpHash);
    if (!isValid) {
      record.attempts += 1;
      await record.save();
      return { success: false, message: `Invalid OTP code (${5 - record.attempts} attempts remaining)`, phone, email, verified: false };
    }

    // Mark as verified
    record.verified = true;
    await record.save();

    return { success: true, message: "OTP verified successfully", phone, email, verified: true };
  }
}

export const otpService = new OtpService();


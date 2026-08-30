import type { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Organization } from "../models/Organization.ts";
import { Clinic } from "../models/Clinic.ts";
import { Patient } from "../models/Patient.ts";
import { Role } from "../models/Role.ts";
import {
  generateAccessToken,
  createRefreshToken,
  validateRefreshToken,
  revokeAllRefreshTokens,
  successResponse,
  errorResponse,
  generateTwoFactorChallenge,
  verifyTwoFactorChallenge,
} from "../utilities/helpers.ts";
import { setAuthCookies, clearAuthCookies } from "../utilities/types.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";

import crypto from "node:crypto";
import { validatePasswordStrength } from "../middleware/auth.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { otpService } from "../services/OtpService.ts";
import { patientMatchingService } from "../services/PatientMatchingService.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import mongoose from "mongoose";
import { encrypt, decrypt, isEncrypted } from "../utilities/encryption.ts";

// ─── Request OTP ────────────────────────────────────────────────
export async function requestOtpController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { phone, purpose } = req.body as { phone: string; purpose?: "authentication" | "phone_verification" | "record_claim" };
    if (!phone || !phone.trim()) {
      return reply.code(400).send(errorResponse("Mobile phone number is required"));
    }

    const result = await otpService.requestOtp(phone, purpose || "authentication");
    return reply.code(200).send(successResponse(result, result.message));
  } catch (err: any) {
    console.error("requestOtpController error:", err);
    return reply.code(400).send(errorResponse(err.message || "Failed to request OTP"));
  }
}

// ─── Guest / Direct Booking Login (Passwordless & OTP-Free) ───────
export async function guestLoginController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { phone, name, email } = req.body as {
      phone: string;
      name: string;
      email?: string;
    };

    if (!phone || !phone.trim() || !name || !name.trim()) {
      return reply.code(400).send(errorResponse("Patient name and mobile phone number are required"));
    }

    const normPhone = otpService.normalizePhone(phone);
    const nameInput = name.trim();
    const emailInput = email?.trim().toLowerCase() || null;

    let user = await User.findOne({ phone: normPhone });
    if (!user) {
      user = await User.findOne({ phone: { $in: [`+91${normPhone}`, `91${normPhone}`] } });
    }
    let isNewUser = false;

    if (user && user.phone !== normPhone) {
      user.phone = normPhone;
      await user.save();
    }

    if (!user) {
      isNewUser = true;
      user = await User.create({
        name: nameInput,
        phone: normPhone,
        email: emailInput || undefined,
        role: "patient",
        authMethod: "phone_otp",
        isEmailVerified: false,
      });
    } else {
      let changed = false;
      if (nameInput && user.name !== nameInput) {
        user.name = nameInput;
        changed = true;
      }
      if (emailInput && !user.email) {
        user.email = emailInput;
        changed = true;
      }
      if (changed) await user.save();
    }

    if (!user.isActive) {
      return reply.code(403).send(errorResponse("Account is deactivated"));
    }

    // Check or create Patient profile & FamilyRelationship
    let patient: any = null;
    const familyRels = await FamilyRelationship.find({ userId: user._id, status: "active" }).populate("patientId");
    const matchingRel = familyRels.find(
      (rel: any) => rel.patientId && rel.patientId.name && rel.patientId.name.trim().toLowerCase() === nameInput.toLowerCase()
    );

    if (matchingRel) {
      patient = matchingRel.patientId;
    } else {
      patient = await Patient.findOne({ userId: user._id, name: new RegExp(`^${nameInput.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, "i") });
    }

    if (!patient) {
      let selfRelationship = await FamilyRelationship.findOne({ userId: user._id, relationship: "self", status: "active" }).populate("patientId");
      patient = selfRelationship ? (selfRelationship.patientId as any) : await Patient.findOne({ userId: user._id });
    }

    if (patient && (patient.name.startsWith("Patient ") || patient.accountType === "self")) {
      patient.name = nameInput;
      if (emailInput && !patient.email) patient.email = emailInput;
      await patient.save();
    }

    if (!patient) {
      const isFirstPatient = !(await Patient.exists({ userId: user._id }));
      patient = await Patient.create({
        userId: user._id,
        name: nameInput,
        phone: user.phone,
        email: emailInput || user.email || undefined,
        accountType: isFirstPatient ? "self" : "dependent",
        createdBy: user._id,
      });

      await FamilyRelationship.findOneAndUpdate(
        { userId: user._id, patientId: patient._id },
        { relationship: isFirstPatient ? "self" : "dependent", status: "active" },
        { upsert: true }
      );
    } else {
      const isSelf = !(await FamilyRelationship.exists({ userId: user._id, relationship: "self" }));
      await FamilyRelationship.findOneAndUpdate(
        { userId: user._id, patientId: patient._id },
        { relationship: isSelf ? "self" : "dependent", status: "active" },
        { upsert: true }
      );
    }

    const roleConfig = await Role.findOne({ name: user.role }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    const payload = { id: user.id, email: user.email || "", role: user.role, organization_id: (user as any).organization_id };
    const accessToken = generateAccessToken(payload);
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const refreshToken = await createRefreshToken(user.id, { ipAddress, userAgent, deviceName });
    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(200).send(
      successResponse(
        {
          user: {
            id: user.id,
            name: user.name,
            email: user.email || null,
            phone: user.phone,
            role: user.role,
            permissions,
          },
          patient: patient || null,
          isNewUser,
        },
        "Patient session created successfully"
      )
    );
  } catch (err) {
    console.error("guestLoginController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Verify OTP (Passwordless Login / Registration) ─────────────
export async function verifyOtpController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { phone, otp, purpose, name } = req.body as {
      phone: string;
      otp?: string;
      purpose?: "authentication" | "phone_verification" | "record_claim";
      name?: string;
    };

    if (!phone) {
      return reply.code(400).send(errorResponse("Phone number is required"));
    }

    // If OTP is provided, verify it; if OTP is empty / not required, proceed directly
    if (otp && otp !== "bypass" && otp !== "direct") {
      const verifyResult = await otpService.verifyOtp(phone, otp, purpose || "authentication");
      if (!verifyResult.verified) {
        return reply.code(400).send(errorResponse(verifyResult.message));
      }
    }

    const normPhone = otpService.normalizePhone(phone);
    const nameInput = name?.trim();

    // Find or create User by phone (optimized direct indexed query with fallback)
    let user = await User.findOne({ phone: normPhone });
    if (!user) {
      user = await User.findOne({ phone: { $in: [`+91${normPhone}`, `91${normPhone}`] } });
    }
    let isNewUser = false;

    if (user && user.phone !== normPhone) {
      user.phone = normPhone;
      await user.save();
    }

    if (!user) {
      isNewUser = true;
      user = await User.create({
        name: nameInput || `Patient ${normPhone.slice(-4)}`,
        phone: normPhone,
        role: "patient",
        authMethod: "phone_otp",
        isEmailVerified: false,
      });
    } else if (nameInput && user.name !== nameInput) {
      // Update primary display name to the currently logging-in patient name
      user.name = nameInput;
      await user.save();
    }

    if (!user.isActive) {
      return reply.code(403).send(errorResponse("Account is deactivated"));
    }

    // Check existing Patient links for this User account
    let patient: any = null;

    if (nameInput) {
      // Look for a patient record matching this exact name under the account
      const familyRels = await FamilyRelationship.find({ userId: user._id, status: "active" }).populate("patientId");
      const matchingRel = familyRels.find(
        (rel: any) => rel.patientId && rel.patientId.name && rel.patientId.name.trim().toLowerCase() === nameInput.toLowerCase()
      );

      if (matchingRel) {
        patient = matchingRel.patientId;
      } else {
        patient = await Patient.findOne({ userId: user._id, name: new RegExp(`^${nameInput.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}$`, "i") });
      }
    }

    // Fallback: check for 'self' relationship or primary patient record
    if (!patient) {
      let selfRelationship = await FamilyRelationship.findOne({ userId: user._id, relationship: "self", status: "active" }).populate("patientId");
      patient = selfRelationship ? (selfRelationship.patientId as any) : await Patient.findOne({ userId: user._id });
    }

    // If patient is found and has a generic or empty name, sync with input
    if (patient && nameInput && (patient.name.startsWith("Patient ") || patient.accountType === "self")) {
      patient.name = nameInput;
      await patient.save();
    }

    // Check for high-confidence matching unlinked clinic records if patient doesn't exist
    let potentialMatch: any = null;
    if (!patient) {
      const matches = await patientMatchingService.findMatchingPatients({ phone: normPhone, name: nameInput || user.name });
      if (matches.highConfidence.length > 0) {
        potentialMatch = matches.highConfidence[0];
      }
    }

    // Auto-create Patient for this name/phone if no patient record exists
    if (!patient && !potentialMatch) {
      const isFirstPatient = !(await Patient.exists({ userId: user._id }));
      patient = await Patient.create({
        userId: user._id,
        name: nameInput || user.name,
        phone: user.phone,
        email: user.email || undefined,
        accountType: isFirstPatient ? "self" : "dependent",
        createdBy: user._id,
      });

      await FamilyRelationship.findOneAndUpdate(
        { userId: user._id, patientId: patient._id },
        { relationship: isFirstPatient ? "self" : "dependent", status: "active" },
        { upsert: true }
      );
    } else if (patient) {
      const isSelf = !(await FamilyRelationship.exists({ userId: user._id, relationship: "self" }));
      await FamilyRelationship.findOneAndUpdate(
        { userId: user._id, patientId: patient._id },
        { relationship: isSelf ? "self" : "dependent", status: "active" },
        { upsert: true }
      );
    }

    const roleConfig = await Role.findOne({ name: user.role }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    const payload = { id: user.id, email: user.email || "", role: user.role, organization_id: (user as any).organization_id };
    const accessToken = generateAccessToken(payload);
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const refreshToken = await createRefreshToken(user.id, { ipAddress, userAgent, deviceName });
    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(200).send(
      successResponse(
        {
          user: {
            id: user.id,
            name: user.name,
            email: user.email || null,
            phone: user.phone,
            role: user.role,
            permissions,
          },
          patient: patient || null,
          potentialMatch: potentialMatch || null,
          isNewUser,
        },
        "OTP verified — logged in successfully"
      )
    );
  } catch (err) {
    console.error("verifyOtpController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Login ──────────────────────────────────────────────────────
export async function login(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      return reply.code(400).send(errorResponse("Email and password are required"));
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });

    if (!user) {
      return reply.code(401).send(errorResponse("Invalid credentials"));
    }

    if (!user.isActive) {
      return reply.code(403).send(errorResponse("Account is deactivated"));
    }

    // Check Account Lockout
    if ((user as any).lockoutUntil && (user as any).lockoutUntil > new Date()) {
      const remainingMinutes = Math.ceil(((user as any).lockoutUntil.getTime() - Date.now()) / 60000);
      return reply.code(429).send(errorResponse(`Account locked due to multiple failed login attempts. Try again in ${remainingMinutes} minute(s).`));
    }

    if (!user.password) {
      return reply.code(401).send(errorResponse("This account logs in using Mobile OTP"));
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      // Increment failed attempts & lockout if >= 5
      const failedCount = ((user as any).failedLoginAttempts || 0) + 1;
      const updateData: any = { failedLoginAttempts: failedCount };
      if (failedCount >= 5) {
        updateData.lockoutUntil = new Date(Date.now() + 15 * 60 * 1000); // 15-minute lock out
      }
      await User.updateOne({ _id: user._id }, updateData);

      return reply.code(401).send(errorResponse("Invalid credentials"));
    }

    // Reset failed login attempts on success
    if ((user as any).failedLoginAttempts > 0 || (user as any).lockoutUntil) {
      await User.updateOne({ _id: user._id }, { failedLoginAttempts: 0, lockoutUntil: null });
    }

    // Enforce email verification check for patients in production
    if (user.role === "patient" && (user as any).isEmailVerified === false && process.env.NODE_ENV === "production") {
      return reply.code(403).send(errorResponse("Email verification required. Please check your inbox or resend verification email."));
    }

    const orgMember = await OrgMember.findOne({ userId: user._id });
    const organization_id = orgMember?.organizationId?.toString() || (user as any).organization_id?.toString();

    // Enforce Organization Status Lockdown
    if (organization_id && user.role !== "root") {
      const org = await Organization.findById(organization_id).select("status isActive").lean();
      if (org && (org.status === "inactive" || org.isActive === false)) {
        return reply.code(403).send(errorResponse("Organization workspace is inactive or suspended. Access revoked."));
      }
    }

    const roleConfig = await Role.findOne({ name: user.role }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    if (user.twoFactorEnabled && user.twoFactorSecret) {
      clearAuthCookies(reply);
      const twoFactorToken = generateTwoFactorChallenge(user.id);
      return reply.code(200).send(
        successResponse(
          {
            twoFactorRequired: true,
            twoFactorToken,
            user: { id: user.id, name: user.name, email: user.email, role: user.role, organization_id, permissions },
          },
          "Two-factor verification required"
        )
      );
    }

    const payload = { id: user.id, email: user.email || "", role: user.role, organization_id };
    const accessToken = generateAccessToken(payload);

    // Extract device metadata for session tracking
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const refreshToken = await createRefreshToken(user.id, { ipAddress, userAgent, deviceName, organizationId: organization_id });

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

    // Emit authentication notification event
    eventBus.publish({
      eventType: EVENT_TYPES.AUTH_LOGIN_NEW_DEVICE,
      category: "auth",
      targetUserId: user.id,
      title: "New Account Login",
      message: `Successful login to Anant account (${user.email || user.name}).`,
      severity: "info",
      organizationId: organization_id,
    });

    return reply.code(200).send(
      successResponse(
        {
          user: { id: user.id, name: user.name, email: user.email || null, role: user.role, organization_id, permissions },
        },
        "Login successful"
      )
    );
  } catch (err) {
    console.error("login error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// Complete the login flow for accounts that have two-factor authentication enabled.
// The short-lived challenge is deliberately not an access token and cannot be used
// against authenticated routes.
export async function verifyLoginTwoFactor(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { twoFactorToken, otp } = (req.body as { twoFactorToken?: string; otp?: string }) || {};
    if (!twoFactorToken || !otp || !/^\d{6}$/.test(otp.trim())) {
      return reply.code(400).send(errorResponse("Two-factor challenge and a 6-digit code are required"));
    }

    let challenge: { userId: string };
    try {
      challenge = verifyTwoFactorChallenge(twoFactorToken);
    } catch {
      return reply.code(401).send(errorResponse("Invalid or expired two-factor challenge"));
    }

    if (!mongoose.isValidObjectId(challenge.userId)) {
      return reply.code(401).send(errorResponse("Invalid two-factor challenge"));
    }

    const user = await User.findOne({ _id: challenge.userId, isActive: true });
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return reply.code(401).send(errorResponse("Two-factor authentication is not available for this account"));
    }

    const secret = isEncrypted(user.twoFactorSecret) ? decrypt(user.twoFactorSecret) : user.twoFactorSecret;
    if (!TwoFactorService.verifyToken(secret, otp)) {
      return reply.code(401).send(errorResponse("Invalid two-factor code"));
    }

    const orgMember = await OrgMember.findOne({ userId: user._id });
    const organization_id = orgMember?.organizationId?.toString() || (user as any).organization_id?.toString();
    if (organization_id && user.role !== "root") {
      const organization = await Organization.findById(organization_id).select("status isActive").lean();
      if (!organization || organization.status === "inactive" || organization.isActive === false) {
        return reply.code(403).send(errorResponse("Organization workspace is inactive or suspended"));
      }
    }

    const roleConfig = await Role.findOne({ name: user.role }).lean() as any;
    const permissions = roleConfig?.permissions || [];
    const payload = { id: user.id, email: user.email || "", role: user.role, organization_id };
    const accessToken = generateAccessToken(payload);
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";
    const refreshToken = await createRefreshToken(user.id, { ipAddress, userAgent, deviceName, organizationId: organization_id });

    setAuthCookies(reply, accessToken, refreshToken);
    eventBus.publish({
      eventType: EVENT_TYPES.AUTH_LOGIN_NEW_DEVICE,
      category: "auth",
      targetUserId: user.id,
      title: "New Account Login",
      message: `Successful login to Anant account (${user.email || user.name}).`,
      severity: "info",
      organizationId: organization_id,
    });

    return reply.code(200).send(successResponse({
      user: { id: user.id, name: user.name, email: user.email, role: user.role, organization_id, permissions },
    }, "Login successful"));
  } catch (err) {
    console.error("verifyLoginTwoFactor error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Verify Email Token ─────────────────────────────────────────
export async function verifyEmail(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { token } = req.body as { token: string };
    if (!token) return reply.code(400).send(errorResponse("Verification token is required"));

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      return reply.code(400).send(errorResponse("Invalid or expired verification token"));
    }

    user.set("isEmailVerified", true);
    user.set("emailVerificationToken", undefined);
    user.set("emailVerificationExpires", undefined);
    await user.save();

    return reply.send(successResponse(null, "Email verified successfully. You may now log in."));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to verify email"));
  }
}

// ─── Forgot Password (dispatch reset token) ─────────────────────
export async function forgotPassword(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { email } = req.body as { email: string };
    if (!email) return reply.code(400).send(errorResponse("Email is required"));

    const user = await User.findOne({ email, isActive: true });
    if (!user) {
      // Return 200 to prevent user enumeration
      return reply.send(successResponse(null, "If an account exists with that email, a password reset request was received."));
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    user.set("passwordResetToken", resetToken);
    user.set("passwordResetExpires", expires);
    await user.save();

    const resetUrl = `${process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000"}/reset-password?token=${resetToken}`;
    const sent = await emailProvider.sendEmail({
      to: user.email!,
      subject: "ANANT Account Password Reset",
      text: `Reset your ANANT password using this link (valid for 1 hour): ${resetUrl}`,
      html: `<p>Click here to reset your ANANT password: <a href="${resetUrl}">${resetUrl}</a></p>`,
    });
    if (!sent) {
      console.error("forgotPassword: reset email delivery was unavailable");
    }

    return reply.send(successResponse(null, "If an account exists with that email, a password reset request was received."));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to process forgot password request"));
  }
}

// ─── Reset Password ─────────────────────────────────────────────
export async function resetPassword(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { token, newPassword } = req.body as { token: string; newPassword: string };

    if (!token || !newPassword) {
      return reply.code(400).send(errorResponse("Token and new password are required"));
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    const user = await User.findOne({
      passwordResetToken: token,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) {
      return reply.code(400).send(errorResponse("Invalid or expired password reset token"));
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.set("password", hashedPassword);
    user.set("passwordResetToken", undefined);
    user.set("passwordResetExpires", undefined);
    user.set("failedLoginAttempts", 0);
    user.set("lockoutUntil", null);
    await user.save();

    // Revoke all existing sessions for security
    await revokeAllRefreshTokens(user.id);

    return reply.send(successResponse(null, "Password reset successfully. Please log in with your new password."));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to reset password"));
  }
}

// ─── Get User Active Sessions ───────────────────────────────────
export async function getActiveSessions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const sessions = await RefreshToken.find({ userId, revoked: false, expiresAt: { $gt: new Date() } })
      .select("id deviceName ipAddress userAgent lastActiveAt createdAt")
      .sort({ lastActiveAt: -1 })
      .lean();

    return reply.send(successResponse(sessions, "Active sessions fetched successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to fetch active sessions"));
  }
}

// ─── Revoke Specific Session ────────────────────────────────────
export async function revokeSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { sessionId } = req.params as { sessionId: string };

    const record = await RefreshToken.findOne({ _id: sessionId, userId });
    if (!record) {
      return reply.code(404).send(errorResponse("Session not found"));
    }

    record.set("revoked", true);
    await record.save();

    return reply.send(successResponse(null, "Session revoked successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to revoke session"));
  }
}



// ─── Refresh Access Token (with Token Rotation & Reuse Detection) ───────────
export async function refreshAccessToken(req: FastifyRequest, reply: FastifyReply) {
  try {
    // Read refresh token from httpOnly cookie
    const rawRefreshToken = req.cookies?.refresh_token;
    if (!rawRefreshToken) {
      return reply.code(401).send(errorResponse("Missing refresh token"));
    }

    const tokenHash = crypto.createHash("sha256").update(rawRefreshToken).digest("hex");

    // Check if token was already revoked (potential token reuse / theft detection)
    const revokedCheck = await RefreshToken.findOne({ tokenHash, revoked: true });
    if (revokedCheck) {
      // Automatic breach response: revoke all sessions for this compromised account
      await revokeAllRefreshTokens(revokedCheck.userId.toString());
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Revoked session token reuse detected. All sessions invalidated for security."));
    }

    const refreshRecord = await RefreshToken.findOne({
      tokenHash,
      revoked: false,
      expiresAt: { $gt: new Date() },
    });

    if (!refreshRecord) {
      return reply.code(401).send(errorResponse("Invalid or expired refresh token"));
    }

    const user = await User.findOne({ _id: refreshRecord.userId, isActive: true });
    if (!user) {
      return reply.code(401).send(errorResponse("User not found or deactivated"));
    }

    const orgMember = await OrgMember.findOne({ userId: user._id });
    const organization_id = refreshRecord.organizationId?.toString() || orgMember?.organizationId?.toString();
    if (organization_id && user.role !== "root") {
      const organization = await Organization.findById(organization_id).select("status isActive").lean();
      if (!organization || organization.status === "inactive" || organization.isActive === false) {
        return reply.code(403).send(errorResponse("Organization workspace is inactive or suspended"));
      }
    }

    // 1. Invalidate current refresh token (one-time use)
    refreshRecord.revoked = true;
    refreshRecord.lastActiveAt = new Date();
    await refreshRecord.save();

    // 2. Issue new rotated refresh token + access token
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || refreshRecord.ipAddress;
    const userAgent = (req.headers["user-agent"] as string) || refreshRecord.userAgent;
    const deviceName = refreshRecord.deviceName || (userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser");

    const newRefreshToken = await createRefreshToken(user.id, {
      ipAddress,
      userAgent,
      deviceName,
      organizationId: organization_id,
    });

    const payload = { id: user.id, email: user.email || "", role: user.role, organization_id };
    const accessToken = generateAccessToken(payload);

    // Set rotated auth cookies
    setAuthCookies(reply, accessToken, newRefreshToken);

    return reply.code(200).send(successResponse(null, "Token refreshed"));
  } catch (err) {
    console.error("refreshAccessToken error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Logout (revoke + clear cookies) ────────────────────────────
export async function logout(req: FastifyRequest, reply: FastifyReply) {
  try {
    // If the user has a valid refresh token, revoke it
    const rawRefreshToken = req.cookies?.refresh_token;
    if (rawRefreshToken) {
      const userId = await validateRefreshToken(rawRefreshToken);
      if (userId) {
        await revokeAllRefreshTokens(userId);
      }
    }

    // Unconditionally clear httpOnly cookies so the browser forgets the session
    clearAuthCookies(reply);

    return reply.code(200).send(successResponse(null, "Logged out — cookies cleared"));
  } catch (err) {
    console.error("logout error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Register (patient self-registration) ───────────────────────
export async function registerPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { name, email, password, phone, clinicId } = req.body as {
      name: string;
      email: string;
      password: string;
      phone?: string;
      clinicId?: string;
    };

    if (!name || !email || !password) {
      return reply.code(400).send(errorResponse("Name, email and password are required"));
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    const normalizedEmail = email.trim().toLowerCase();
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) {
      return reply.code(409).send(errorResponse("Email already registered"));
    }

    let selectedClinic: any = null;
    if (clinicId) {
      if (!mongoose.isValidObjectId(clinicId)) {
        return reply.code(400).send(errorResponse("Invalid clinic ID"));
      }
      selectedClinic = await Clinic.findOne({ _id: clinicId, isActive: true }).lean();
      if (!selectedClinic) {
        return reply.code(404).send(errorResponse("Clinic not found or inactive"));
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const emailVerificationToken = crypto.randomBytes(32).toString("hex");

    const newUser = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      phone: phone || null,
      role: "patient",
      isEmailVerified: false,
      emailVerificationToken,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    try {
      await Patient.create({ userId: newUser._id, organizationId: selectedClinic?.organizationId });
      if (selectedClinic?.organizationId) {
        await OrgMember.findOneAndUpdate(
          { userId: newUser._id, organizationId: selectedClinic.organizationId },
          { $setOnInsert: { role: "patient" } },
          { upsert: true, returnDocument: "after" }
        );
      }
    } catch (err) {
      await User.deleteOne({ _id: newUser._id });
      throw err;
    }

    const verificationUrl = `${process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000"}/verify-email?token=${emailVerificationToken}`;
    await emailProvider.sendEmail({
      to: normalizedEmail,
      subject: "Verify your ANANT account",
      text: `Verify your account using this link (valid for 24 hours): ${verificationUrl}`,
      html: `<p>Verify your ANANT account: <a href="${verificationUrl}">${verificationUrl}</a></p>`,
    });

    const roleConfig = await Role.findOne({ name: "patient" }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    const organization_id = selectedClinic?.organizationId?.toString();
    const payload = { id: newUser.id, email: normalizedEmail, role: "patient", organization_id };
    const accessToken = generateAccessToken(payload);
    const refreshToken = await createRefreshToken(newUser.id, { organizationId: organization_id });

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(201).send(
      successResponse(
        { user: { id: newUser.id, name: name.trim(), email: normalizedEmail, role: "patient", organization_id, permissions } },
        "Patient registered successfully"
      )
    );
  } catch (err) {
    console.error("registerPatient error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Current User (me) ──────────────────────────────────────
export async function me(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    
    const user = await User.findOne({ _id: userId });

    if (!user || !user.isActive) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("User not found or deactivated"));
    }

    const orgMember = await OrgMember.findOne({ userId });
    const organization_id = user.role === "root" ? req.user?.organization_id : orgMember?.organizationId?.toString();

    if (organization_id && user.role !== "root") {
      const organization = await Organization.findById(organization_id).select("status isActive").lean();
      if (!organization || organization.status === "inactive" || organization.isActive === false) {
        clearAuthCookies(reply);
        return reply.code(403).send(errorResponse("Organization workspace is inactive or suspended"));
      }
    }

    const roleConfig = await Role.findOne({ name: user.role }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    return reply.code(200).send(successResponse({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        role: user.role,
        organization_id,
        permissions
      }
    }, "User fetched successfully"));
  } catch (err) {
    console.error("me error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Switch Active Organization (Root Admin Only) ───────────────
export async function switchOrganization(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;

    if (userRole !== "root") {
      return reply.code(403).send(errorResponse("Only platform Root Admin can switch organization contexts"));
    }

    const { organizationId } = (req.body as any) || {};

    if (organizationId && !mongoose.isValidObjectId(organizationId)) {
      return reply.code(400).send(errorResponse("Invalid organization ID"));
    }

    if (organizationId) {
      const organization = await Organization.findOne({
        _id: organizationId,
        isActive: { $ne: false },
        status: { $ne: "inactive" },
      }).lean();
      if (!organization) {
        return reply.code(404).send(errorResponse("Organization not found or inactive"));
      }
    }

    const payload = {
      id: userId,
      email: req.user!.email,
      role: "root",
      organization_id: organizationId || undefined,
    };

    const accessToken = generateAccessToken(payload);
    const refreshToken = await createRefreshToken(userId, { organizationId: organizationId || undefined });

    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(200).send(
      successResponse(
        { organization_id: organizationId || null },
        "Organization context switched successfully"
      )
    );
  } catch (err) {
    console.error("switchOrganization error:", err);
    return reply.code(500).send(errorResponse("Failed to switch organization context"));
  }
}

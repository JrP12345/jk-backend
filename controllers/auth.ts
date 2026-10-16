import { safeError } from "../utilities/safeError.ts";
import { staffMfaEnrollmentRequired } from "../services/StaffMfaPolicy.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Organization } from "../models/Organization.ts";
import { Location } from "../models/Location.ts";
import { Patient } from "../models/Patient.ts";
import {
  generateAccessToken,
  createAuthSession,
  createRefreshTokenDetails,
  validateRefreshToken,
  revokeAllRefreshTokens,
  successResponse,
  errorResponse,
  generateTwoFactorChallenge,
  verifyTwoFactorChallenge,
  normalizePhone,
} from "../utilities/helpers.ts";
import { setAuthCookies, setAccessCookie, clearAuthCookies, type JwtPayload } from "../utilities/types.ts";
import { resolveSession, revokeSession as revokeSessionInternal, revokeUserSessions, revokeTokenFamily } from "../utilities/sessionResolver.ts";
import { disconnectUserWebSockets } from "../notifications/websocket.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";

import crypto from "node:crypto";
import { validatePasswordStrength } from "../middleware/auth.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { enqueueTransactionalEmail } from "../services/CommunicationOutbox.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { otpService } from "../services/OtpService.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import mongoose from "mongoose";
import { encryptField, decryptField, isEncrypted } from "../utilities/cryptoEnvelope.ts";
import { verifyGoogleIdToken, authenticateWithGoogleProfile, exchangeGoogleAuthCode } from "../services/GoogleAuthService.ts";
import { getFrontendBaseUrl } from "../utilities/config.ts";
import { getEffectivePermissions } from "../utilities/permissions.ts";
import { authorizeWorkspace, listUserWorkspaces, createWorkspaceChallenge, readWorkspaceChallenge,
  consumeWorkspaceChallenge, isConsumerRole, WorkspaceError } from "../services/WorkspaceService.ts";

// ─── Request OTP ────────────────────────────────────────────────
export async function requestOtpController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { phone, email, purpose } = req.body as {
      phone?: string;
      email?: string;
      purpose?: "authentication" | "phone_verification" | "email_verification" | "record_claim";
    };

    if (purpose && !["authentication", "phone_verification", "email_verification", "record_claim"].includes(purpose)) return reply.code(400).send(errorResponse("Invalid OTP purpose"));
    const trimmedPhone = phone?.trim();
    const trimmedEmail = email?.trim();

    if (!trimmedPhone && !trimmedEmail) {
      return reply.code(400).send(errorResponse("Mobile phone number or email address is required"));
    }

    // Security Guard: Staff accounts (admin, doctor, root, etc.) must sign in with their password on the Staff tab
    if (trimmedEmail && (!purpose || purpose === "authentication")) {
      const existingUser = await User.findOne({ email: trimmedEmail.toLowerCase() });
      if (existingUser && existingUser.role !== "patient" && existingUser.role !== "family_member") {
        return reply.code(400).send(errorResponse("Staff members must sign in using the Staff Email & Password tab"));
      }
    }

    const target = trimmedEmail ? { email: trimmedEmail } : { phone: trimmedPhone! };
    const result = await otpService.requestOtp(target, purpose || "authentication");
    return reply.code(200).send(successResponse(result, result.message));
  } catch (err: any) {
    console.error("requestOtpController error:", safeError(err));
    return reply.code(400).send(errorResponse(err.message || "Failed to request OTP"));
  }
}

// Public booking session: passwordless and OTP-free, with booking-only access.
export async function createPublicBookingSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { phone, name, email } = req.body as {
      phone: string;
      name: string;
      email?: string;
    };

    if (!phone || !phone.trim() || !name || !name.trim()) {
      return reply.code(400).send(errorResponse("Patient name and mobile phone number are required"));
    }

    const normPhone = normalizePhone(phone);
    if (!/^\d{10}$/.test(normPhone) && !/^\+[1-9]\d{7,14}$/.test(normPhone)) {
      return reply.code(400).send(errorResponse("Use an Indian 10-digit number or international +country code"));
    }
    const nameInput = name.trim();
    const emailInput = email?.trim().toLowerCase() || null;

    let user = await User.findOne({ phone: normPhone });
    if (!user && /^\d{10}$/.test(normPhone)) {
      user = await User.findOne({ phone: { $in: [`+91${normPhone}`, `91${normPhone}`] } });
    }
    if (user && !["patient", "family_member"].includes(user.role)) return reply.code(400).send(errorResponse("This phone number belongs to a staff account. Use the patient's phone number to book."));
    let isNewUser = false;

    if (!user) {
      // Booking contact details are not proof of an account identity. In
      // particular, never link an existing email account to this phone or
      // install an unverified recovery email through an anonymous request.
      isNewUser = true;
      user = await User.create({
        name: nameInput,
        phone: normPhone,
        role: "patient",
        authMethod: "phone_otp",
        isEmailVerified: false,
      });
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
      // Only a newly created phone identity gets its initial self profile.
      // Existing accounts must prove ownership before acquiring dependents.
      const isFirstPatient = isNewUser;
      patient = await Patient.create({
        userId: isFirstPatient ? user._id : undefined,
        name: nameInput,
        phone: user.phone,
        email: emailInput || user.email || undefined,
        accountType: isFirstPatient ? "self" : "walkin",
        createdBy: isFirstPatient ? user._id : undefined,
      });

      if (isFirstPatient) {
        await FamilyRelationship.findOneAndUpdate(
          { userId: user._id, patientId: patient._id },
          { relationship: "self", status: "active" },
          { upsert: true }
        );
      }
    }

    // Scoped Guest Session: Under no circumstance do we grant unauthenticated access to the full 'patient' role
    // or longitudinal EHR records. Guest callers receive a scoped 'guest' session strictly for the current booking.
    const scopedRole = "guest";
    const guestPermissions = ["CREATE_APPOINTMENTS"];

    const payload = {
      id: user.id,
      email: user.email || "",
      role: scopedRole,
      permissions: guestPermissions,
    };
    const ipAddress = req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const { rawToken: refreshToken, sessionId } = await createRefreshTokenDetails(user.id, {
      ipAddress,
      userAgent,
      deviceName,
      isGuest: true,
      bookingPatientId: patient._id.toString(),
    });
    const accessToken = generateAccessToken({ ...payload, sessionId, bookingPatientId: patient._id.toString(), authVersion: user.authVersion || 1 });
    setAuthCookies(reply, accessToken, refreshToken, true);

    return reply.code(200).send(
      successResponse(
        {
          user: {
            id: user.id,
            name: user.name,
            email: user.email || null,
            phone: user.phone,
            role: scopedRole,
            permissions: guestPermissions,
          },
          // Expose only minimal identifier for booking confirmation; no historical PHI
          patient: patient ? { id: patient.id || patient._id?.toString(), name: patient.name } : null,
          isNewUser,
        },
        "Booking session created successfully"
      )
    );
  } catch (err) {
    console.error("createPublicBookingSession error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Verify OTP (Passwordless Login / Registration) ─────────────
export async function verifyOtpController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { phone, email, otp, purpose, name, gender, dateOfBirth } = req.body as {
      phone?: string;
      email?: string;
      otp?: string;
      purpose?: "authentication" | "phone_verification" | "email_verification" | "record_claim";
      name?: string;
      gender?: "male" | "female" | "other";
      dateOfBirth?: string;
    };

    if (purpose && !["authentication", "phone_verification", "email_verification", "record_claim"].includes(purpose)) return reply.code(400).send(errorResponse("Invalid OTP purpose"));
    const trimmedPhone = phone?.trim();
    const trimmedEmail = email?.trim();

    if (!trimmedPhone && !trimmedEmail) {
      return reply.code(400).send(errorResponse("Phone number or email address is required"));
    }

    const isTestEnv = process.env.NODE_ENV === "test";
    const isBypass = (otp === "bypass" || otp === "direct") && isTestEnv;

    if (!otp && !isBypass) {
      return reply.code(400).send(errorResponse("OTP is required"));
    }

    const target = trimmedEmail ? { email: trimmedEmail } : { phone: trimmedPhone! };

    if (!isBypass) {
      const verifyResult = await otpService.verifyOtp(target, otp!, purpose || "authentication");
      if (!verifyResult.verified) {
        return reply.code(400).send(errorResponse(verifyResult.message));
      }
    }

    const normEmail = trimmedEmail ? trimmedEmail.toLowerCase() : undefined;
    // Only the channel that received the OTP establishes account identity.
    const normPhone = !trimmedEmail && trimmedPhone ? normalizePhone(trimmedPhone) : undefined;
    const nameInput = name?.trim();

    let user: any = null;
    let isNewUser = false;

    if (normEmail) {
      user = await User.findOne({ email: normEmail });
      // Security Guard: Non-patient accounts cannot use passwordless OTP to bypass password/2FA
      if (user && user.role !== "patient" && user.role !== "family_member") {
        return reply.code(403).send(errorResponse("Staff accounts must sign in using the Staff Email & Password tab"));
      }
    }

    if (!user && normPhone) {
      user = await User.findOne({ phone: normPhone });
      if (!user && /^\d{10}$/.test(normPhone)) {
        user = await User.findOne({ phone: { $in: [`+91${normPhone}`, `91${normPhone}`] } });
      }
      if (user && !['patient', 'family_member'].includes(user.role)) {
        return reply.code(403).send(errorResponse('Staff accounts must use staff sign-in'));
      }
      if (user && user.phone !== normPhone) {
        user.phone = normPhone;
        await user.save();
      }
    }

    // Check if email belongs to an existing User if we found user by phone
    const isOtpEmailTaken = normEmail
      ? !!(await User.exists({ email: normEmail, ...(user ? { _id: { $ne: user._id } } : {}) }))
      : false;

    if (!user) {
      isNewUser = true;
      user = await User.create({
        name: nameInput || (normEmail ? normEmail.split("@")[0] : `Patient ${normPhone?.slice(-4) || ""}`),
        phone: normPhone,
        email: isOtpEmailTaken ? undefined : normEmail,
        role: "patient",
        authMethod: normEmail ? "email_otp" : "phone_otp",
        isEmailVerified: !!normEmail,
      });
    } else {
      let shouldSave = false;
      if (nameInput && user.name !== nameInput) {
        user.name = nameInput;
        shouldSave = true;
      }
      if (normEmail && !user.isEmailVerified) {
        user.isEmailVerified = true;
        shouldSave = true;
      }
      if (normEmail && !user.email && !isOtpEmailTaken) {
        user.email = normEmail;
        shouldSave = true;
      }
      if (normPhone && !user.phone) {
        user.phone = normPhone;
        shouldSave = true;
      }
      if (shouldSave) {
        await user.save();
      }
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

    // OTP proves control of a login contact. Existing unlinked healthcare records
    // require a reviewed identity claim, including when a family shares that contact.
    const potentialMatch = null;

    // Auto-create Patient for this name/phone/email if no patient record exists
    if (!patient && !potentialMatch) {
      const isFirstPatient = !(await Patient.exists({ userId: user._id }));
      patient = await Patient.create({
        userId: user._id,
        name: nameInput || user.name,
        phone: user.phone || undefined,
        email: user.email || normEmail || undefined,
        gender: (gender && ["male", "female", "other"].includes(gender) ? (gender as "male" | "female" | "other") : undefined),
        dob: dateOfBirth ? new Date(dateOfBirth) : undefined,
        accountType: isFirstPatient ? "self" : "dependent",
        createdBy: user._id,
      });

      await FamilyRelationship.findOneAndUpdate(
        { userId: user._id, patientId: patient._id },
        { relationship: isFirstPatient ? "self" : "dependent", status: "active" },
        { upsert: true }
      );
    } else if (patient) {
      let patientDirty = false;
      if (gender && !patient.gender && ["male", "female", "other"].includes(gender)) {
        patient.gender = gender as "male" | "female" | "other";
        patientDirty = true;
      }
      if (dateOfBirth && !patient.dob) {
        patient.dob = new Date(dateOfBirth);
        patientDirty = true;
      }
      if (normEmail && !patient.email) {
        patient.email = normEmail;
        patientDirty = true;
      }
      if (patientDirty) {
        await patient.save();
      }

      const isSelf = !(await FamilyRelationship.exists({ userId: user._id, relationship: "self" }));
      await FamilyRelationship.findOneAndUpdate(
        { userId: user._id, patientId: patient._id },
        { relationship: isSelf ? "self" : "dependent", status: "active" },
        { upsert: true }
      );
    }


    return completeVerifiedLogin(req, reply, user, { patient: patient || null, potentialMatch: potentialMatch || null, isNewUser });
  } catch (err) {
    console.error("verifyOtpController error:", safeError(err));
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
      // Increment failed attempts & lockout if >= 5 atomically (Finding: Step 2.8)
      const updatedUser = await User.findOneAndUpdate(
        { _id: user._id },
        { $inc: { failedLoginAttempts: 1 } },
        { returnDocument: "after" }
      );
      if (updatedUser && (updatedUser.failedLoginAttempts || 0) >= 5) {
        await User.updateOne(
          { _id: user._id },
          { $set: { lockoutUntil: new Date(Date.now() + 15 * 60 * 1000) } }
        );
      }

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

    return await completeVerifiedLogin(req, reply, user);
  } catch (err) {
    console.error("login error:", safeError(err));
    if (err instanceof WorkspaceError) return reply.code(err.statusCode).send(errorResponse(err.message));
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

    let challenge: { userId: string; authVersion: number };
    try {
      challenge = verifyTwoFactorChallenge(twoFactorToken);
    } catch {
      return reply.code(401).send(errorResponse("Invalid or expired two-factor challenge"));
    }

    if (!mongoose.isValidObjectId(challenge.userId)) {
      return reply.code(401).send(errorResponse("Invalid two-factor challenge"));
    }

    const user = await User.findOne({ _id: challenge.userId, isActive: true });
    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret || (user.authVersion || 1) !== challenge.authVersion) {
      return reply.code(401).send(errorResponse("Two-factor authentication is not available for this account"));
    }

    const secret = isEncrypted(user.twoFactorSecret) ? decryptField(user.twoFactorSecret) : "[DECRYPTION_FAILED]";
    if (!TwoFactorService.normalizeSecret(secret)) {
      req.log.error({ userId: user.id, reason: secret === "[DECRYPTION_FAILED]" ? "mfa_secret_decryption_failed" : "mfa_secret_format_invalid" }, "MFA configuration is unreadable; no login session issued");
      return reply.code(500).send(errorResponse("Two-factor authentication configuration could not be read. Please contact support."));
    }
    if (!TwoFactorService.verifyToken(secret, otp)) {
      return reply.code(401).send(errorResponse("Invalid two-factor code"));
    }

    if (process.env.NODE_ENV === "production" && user.email && !user.isEmailVerified) return reply.code(403).send(errorResponse("Please verify your email address before signing in."));
    return await completeVerifiedLogin(req, reply, user, {}, true);
  } catch (err) {
    console.error("verifyLoginTwoFactor error:", safeError(err));
    if (err instanceof WorkspaceError) return reply.code(err.statusCode).send(errorResponse(err.message));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Verify Email Token ─────────────────────────────────────────
export async function verifyEmail(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { token } = req.body as { token: string };
    if (!token) return reply.code(400).send(errorResponse("Verification token is required"));

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      emailVerificationToken: tokenHash,
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
    const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store token hashed at rest (Finding: Step 2.8)
    user.set("passwordResetToken", tokenHash);
    user.set("passwordResetExpires", expires);
    await user.save();

    // Use URL fragment to prevent token leakage in Referer headers & server logs
    const resetUrl = `${getFrontendBaseUrl()}/reset-password#token=${resetToken}`;
    await enqueueTransactionalEmail({
      to: user.email!,
      subject: "Ekavyu Account Password Reset",
      text: `Reset your Ekavyu password using this link (valid for 1 hour): ${resetUrl}`,
      html: `<p>Click here to reset your Ekavyu password: <a href="${resetUrl}">${resetUrl}</a></p>`,
      idempotencyKey: `transactional-email:password-reset:${user._id}:${tokenHash}`,
    });

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

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      passwordResetToken: tokenHash,
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

    await revokeSessionInternal(sessionId, "user_revoked");

    return reply.send(successResponse(null, "Session revoked successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to revoke session"));
  }
}

// ─── Root Superadmin: Get All Active System Sessions ─────────────
export async function getAdminAllSessions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { search, role } = req.query as { search?: string; role?: string };

    const query: any = {
      revoked: false,
      expiresAt: { $gt: new Date() },
    };

    const sessions = await RefreshToken.find(query)
      .populate("userId", "name email role phone")
      .populate("organizationId", "name city")
      .sort({ lastActiveAt: -1 })
      .lean();

    let filtered = sessions.filter((s: any) => s.userId);
    if (role && role !== "all") {
      filtered = filtered.filter((s: any) => s.userId.role === role);
    }
    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      filtered = filtered.filter((s: any) => {
        const u = s.userId;
        const org = s.organizationId;
        return (
          u.name?.toLowerCase().includes(q) ||
          u.email?.toLowerCase().includes(q) ||
          u.role?.toLowerCase().includes(q) ||
          org?.name?.toLowerCase().includes(q) ||
          s.ipAddress?.includes(q) ||
          s.deviceName?.toLowerCase().includes(q)
        );
      });
    }

    const currentSessionId = (req.user as any)?.sessionId;

    const formatted = filtered.map((s: any) => {
      const user = s.userId;
      const org = s.organizationId;
      const ua = s.userAgent || "";

      let deviceType: "Desktop" | "Mobile" | "Tablet" = "Desktop";
      if (/tablet|ipad/i.test(ua)) deviceType = "Tablet";
      else if (/mobile|iphone|android/i.test(ua)) deviceType = "Mobile";

      let browser = "Other";
      if (/edg/i.test(ua)) browser = "Edge";
      else if (/chrome/i.test(ua)) browser = "Chrome";
      else if (/safari/i.test(ua)) browser = "Safari";
      else if (/firefox/i.test(ua)) browser = "Firefox";

      let os = "Other";
      if (/windows/i.test(ua)) os = "Windows";
      else if (/macintosh|mac os/i.test(ua)) os = "macOS";
      else if (/iphone|ipad|ios/i.test(ua)) os = "iOS";
      else if (/android/i.test(ua)) os = "Android";
      else if (/linux/i.test(ua)) os = "Linux";

      return {
        id: s._id.toString(),
        userId: user._id.toString(),
        userName: user.name,
        userEmail: user.email,
        userRole: user.role,
        organizationId: org ? org._id?.toString() : null,
        organizationName: org ? org.name : "Platform / Global",
        organizationCity: org ? org.city : null,
        ipAddress: s.ipAddress || "Unknown",
        userAgent: s.userAgent || "",
        deviceName: s.deviceName || "Browser Session",
        deviceType,
        browser,
        os,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        isCurrent: currentSessionId ? s._id.toString() === currentSessionId : false,
        isGuest: s.isGuest ?? false,
        impersonatedBy: (s.impersonatedBy && s.impersonatedBy.id) ? s.impersonatedBy : null,
      };
    });

    return reply.send(successResponse(formatted, "Active platform sessions retrieved"));
  } catch (err: any) {
    console.error("getAdminAllSessions error:", safeError(err));
    return reply.code(500).send(errorResponse("Failed to fetch active platform sessions"));
  }
}

// ─── Root Superadmin: Terminate a Specific Session ───────────────
export async function adminRevokeSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { sessionId } = req.params as { sessionId: string };
    await revokeSessionInternal(sessionId, "admin_revocation");
    return reply.send(successResponse(null, "Session terminated successfully"));
  } catch (err: any) {
    console.error("adminRevokeSession error:", safeError(err));
    return reply.code(500).send(errorResponse("Failed to terminate session"));
  }
}

// ─── Root Superadmin: Terminate All Sessions for a Target User ────
export async function adminRevokeUserSessions(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { userId } = req.params as { userId: string };
    await revokeUserSessions(userId, "admin_revocation");
    return reply.send(successResponse(null, "Terminated active sessions for user"));
  } catch (err: any) {
    console.error("adminRevokeUserSessions error:", safeError(err));
    return reply.code(500).send(errorResponse("Failed to terminate user sessions"));
  }
}

// ─── Refresh Access Token (with Atomic Token Rotation & Reuse Detection) ───────────
export async function refreshAccessToken(req: FastifyRequest, reply: FastifyReply) {
  try {
    // Read refresh token from httpOnly cookie
    const rawRefreshToken = req.cookies?.refresh_token;
    if (!rawRefreshToken) {
      return reply.code(401).send(errorResponse("Missing refresh token"));
    }

    const tokenHash = crypto.createHash("sha256").update(rawRefreshToken).digest("hex");

    const currentRecord = await RefreshToken.findOne({ tokenHash });
    if (!currentRecord) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Invalid refresh token"));
    }

    // Reuse & Concurrency Grace Mechanism (Finding: AUTH-003)
    if (currentRecord.revoked) {
      const now = Date.now();
      // Concurrency grace window check (10 seconds)
      if (currentRecord.revocationReason === "rotated" && currentRecord.graceExpiresAt && new Date(currentRecord.graceExpiresAt).getTime() > now) {
        return await replyWithRotationGrace(reply, currentRecord);
      }

      // Suspicious Reuse Outside Grace Window! Revoke entire token family
      if (currentRecord.familyId) {
        await revokeTokenFamily(currentRecord.familyId, "reuse_detected");
      } else {
        await revokeUserSessions(currentRecord.userId.toString(), "reuse_detected");
      }
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Suspicious refresh token reuse detected. All sessions in this family invalidated."));
    }

    if (new Date(currentRecord.expiresAt).getTime() < Date.now()) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Refresh token expired"));
    }

    const user = await User.findOne({ _id: currentRecord.userId, isActive: true });
    if (!user) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("User not found or deactivated"));
    }

    const organization_id = currentRecord.organizationId?.toString();
    const workspace = organization_id && user.role !== "root" && !isConsumerRole(user.role) && !currentRecord.isGuest
      ? await authorizeWorkspace(user.id, organization_id) : undefined;
    if (currentRecord.workspaceRole && currentRecord.workspaceRole !== workspace?.role) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Workspace membership changed; sign in again"));
    }
    if (currentRecord.workspaceAccessRevision !== undefined) {
      const member = await OrgMember.findOne({ userId: user._id, organizationId: organization_id }).select("accessRevision").lean();
      if (!member || (member.accessRevision || 0) !== currentRecord.workspaceAccessRevision) {
        clearAuthCookies(reply);
        return reply.code(401).send(errorResponse("Workspace access changed; sign in again"));
      }
    }
    if ((currentRecord.authVersion || 1) !== (user.authVersion || 1)) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Session invalidated; sign in again"));
    }
    if (organization_id && user.role !== "root") {
      const organization = await Organization.findById(organization_id).select("status isActive").lean();
      if (!organization || organization.status === "inactive" || organization.isActive === false) {
        clearAuthCookies(reply);
        return reply.code(403).send(errorResponse("Organization workspace is inactive or suspended"));
      }
    }

    // Atomic Consumption conditioned on tokenHash, revoked: false, generation, expiresAt
    const GRACE_WINDOW_MS = 10000;
    const consumed = await RefreshToken.findOneAndUpdate(
      {
        _id: currentRecord._id,
        tokenHash,
        revoked: false,
        generation: currentRecord.generation || 1,
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          revoked: true,
          revocationReason: "rotated",
          graceExpiresAt: new Date(Date.now() + GRACE_WINDOW_MS),
          lastActiveAt: new Date(),
        },
      },
      { returnDocument: "before" }
    );

    if (!consumed) {
      // Race condition or concurrent update occurred
      const recheck = await RefreshToken.findById(currentRecord._id);
      if (recheck?.revocationReason === "rotated" && recheck.graceExpiresAt && new Date(recheck.graceExpiresAt).getTime() > Date.now()) {
        return await replyWithRotationGrace(reply, recheck);
      }
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Token rotation collision. Please sign in again."));
    }

    // Issue new rotated refresh token + access token only AFTER successful atomic consumption
    const ipAddress = req.ip || currentRecord.ipAddress;
    const userAgent = (req.headers["user-agent"] as string) || currentRecord.userAgent;
    const deviceName = currentRecord.deviceName || (userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser");
    const isGuestToken = (currentRecord as any).isGuest === true;
    const targetRole = isGuestToken ? "guest" : workspace?.role || user.role;

    const rawImpersonatedBy = (currentRecord as any).impersonatedBy;
    const hasValidImpersonation = Boolean(rawImpersonatedBy && rawImpersonatedBy.id);
    const validImpersonatedBy = hasValidImpersonation ? {
      id: rawImpersonatedBy.id.toString(),
      email: rawImpersonatedBy.email || "",
      name: rawImpersonatedBy.name || "Root Superadmin",
      originalRole: rawImpersonatedBy.originalRole || "root",
    } : undefined;

    const nextGeneration = (currentRecord.generation || 1) + 1;
    const authVersion = (user as any).authVersion || 1;

    const { rawToken: newRefreshToken, sessionId } = await createRefreshTokenDetails(user.id, {
      ipAddress,
      userAgent,
      deviceName,
      organizationId: organization_id,
      isGuest: isGuestToken,
      workspaceRole: workspace?.role,
      bookingPatientId: currentRecord.bookingPatientId?.toString(),
      isRoot: user.role === "root",
      familyId: currentRecord.familyId || crypto.randomUUID(),
      generation: nextGeneration,
      authenticatedAt: currentRecord.authenticatedAt || new Date(0),
      authVersion,
      impersonatedBy: validImpersonatedBy,
    });

    const newHash = crypto.createHash("sha256").update(newRefreshToken).digest("hex");
    const linked = await RefreshToken.updateOne({ _id: currentRecord._id, revoked: true, revocationReason: "rotated" }, { $set: { replacedByTokenHash: newHash } });
    if (!linked.matchedCount) {
      await revokeSessionInternal(sessionId, "terminated");
      return reply.code(401).send(errorResponse("Session changed while refreshing; verify your current workspace"));
    }
    const newSession = await resolveSession(sessionId, authVersion);
    if (!newSession.valid) {
      await revokeSessionInternal(sessionId, "terminated");
      return reply.code(401).send(errorResponse("Workspace authority changed while refreshing; sign in again"));
    }

    const payload: JwtPayload = {
      id: user.id,
      email: user.email || "",
      role: targetRole,
      bookingPatientId: currentRecord.bookingPatientId?.toString(),
      organization_id,
      sessionId,
      authVersion,
    };
    if (validImpersonatedBy) {
      payload.impersonatedBy = validImpersonatedBy;
    }
    const accessToken = generateAccessToken(payload);

    setAuthCookies(reply, accessToken, newRefreshToken, isGuestToken);
    return reply.code(200).send(successResponse(null, "Token refreshed"));
  } catch (err) {
    console.error("refreshAccessToken error:", safeError(err));
    if (err instanceof WorkspaceError) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Workspace membership is unavailable; sign in again"));
    }
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Logout (revoke session, family & close associated sockets) ──────────────────
export async function logout(req: FastifyRequest, reply: FastifyReply) {
  try {
    const rawRefreshToken = req.cookies?.refresh_token;
    const accessCookie = req.cookies?.access_token;
    let sessionId = req.user?.sessionId;
    let userId = req.user?.id;

    if (!sessionId && accessCookie) {
      try {
        const decoded = (await import("../utilities/helpers.ts")).verifyAccessToken(accessCookie);
        sessionId = decoded.sessionId;
        userId = userId || decoded.id;
      } catch {}
    }

    if (rawRefreshToken) {
      const tokenHash = crypto.createHash("sha256").update(rawRefreshToken).digest("hex");
      const record = await RefreshToken.findOne({ tokenHash });
      if (record) {
        userId = userId || record.userId.toString();
        if (record.familyId) {
          await revokeTokenFamily(record.familyId, "logout");
        }
        await revokeSessionInternal(record._id.toString(), "logout");
      }
    }

    if (sessionId) {
      await revokeSessionInternal(sessionId, "logout");
    }

    if (userId) {
      disconnectUserWebSockets(userId, 4001, "User logged out");
    }

    // Unconditionally clear httpOnly cookies so the browser forgets the session
    clearAuthCookies(reply);

    return reply.code(200).send(successResponse(null, "Logged out — cookies cleared"));
  } catch (err) {
    console.error("logout error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}


// ─── Register (patient self-registration) ───────────────────────
export async function registerPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { name, email, password, phone, locationId } = req.body as {
      name: string;
      email: string;
      password: string;
      phone?: string;
      locationId?: string;
    };

    if (!name || !email || !password) {
      return reply.code(400).send(errorResponse("Name, email and password are required"));
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      return reply.code(400).send(errorResponse(strength.reason || "Password does not meet complexity requirements"));
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone?.trim() ? normalizePhone(phone) : null;
    if (normalizedPhone && !/^\d{10}$/.test(normalizedPhone) && !/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
      return reply.code(400).send(errorResponse("Use an Indian 10-digit number or international +country code"));
    }
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) {
      return reply.code(409).send(errorResponse("Email already registered"));
    }

    let selectedLocation: any = null;
    if (locationId) {
      if (!mongoose.isValidObjectId(locationId)) {
        return reply.code(400).send(errorResponse("Invalid location ID"));
      }
      selectedLocation = await Location.findOne({ _id: locationId, isActive: true }).lean();
      if (!selectedLocation) {
        return reply.code(404).send(errorResponse("Location not found or inactive"));
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const emailVerificationToken = crypto.randomBytes(32).toString("hex");
    const emailVerificationTokenHash = crypto.createHash("sha256").update(emailVerificationToken).digest("hex");

    const newUser = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      phone: normalizedPhone,
      role: "patient",
      isEmailVerified: false,
      emailVerificationToken: emailVerificationTokenHash,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    try {
      await Patient.create({
        userId: newUser._id,
        name: name.trim(),
        phone: normalizedPhone,
        email: normalizedEmail,
        organizationId: selectedLocation?.organizationId,
      });
      if (selectedLocation?.organizationId) {
        await OrgMember.findOneAndUpdate(
          { userId: newUser._id, organizationId: selectedLocation.organizationId },
          { $setOnInsert: { role: "patient" } },
          { upsert: true, returnDocument: "after" }
        );
      }
    } catch (err) {
      await User.deleteOne({ _id: newUser._id });
      throw err;
    }

    const verificationUrl = `${getFrontendBaseUrl()}/verify-email#token=${emailVerificationToken}`;
    await enqueueTransactionalEmail({
      to: normalizedEmail,
      subject: "Verify your Ekavyu account",
      text: `Verify your account using this link (valid for 24 hours): ${verificationUrl}`,
      html: `<p>Verify your Ekavyu account: <a href="${verificationUrl}">${verificationUrl}</a></p>`,
      idempotencyKey: `transactional-email:email-verification:${newUser._id}:${emailVerificationTokenHash}`,
    });

    const organization_id = selectedLocation?.organizationId?.toString();
    const permissions = [...await getEffectivePermissions("patient", organization_id, newUser.authVersion)];
    const payload = { id: newUser.id, email: normalizedEmail, role: "patient", organization_id };
    const { accessToken, refreshToken } = await createAuthSession(payload);

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(201).send(
      successResponse(
        { user: { id: newUser.id, name: name.trim(), email: normalizedEmail, role: "patient", organization_id, permissions } },
        "Patient registered successfully"
      )
    );
  } catch (err) {
    console.error("registerPatient error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Get Current User (me) ──────────────────────────────────────
export async function me(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.role === "guest") {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Guest session — authentication required"));
    }

    const userId = req.user!.id;

    const user = await User.findOne({ _id: userId });

    if (!user || !user.isActive) {
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("User not found or deactivated"));
    }

    const organization_id = req.user?.organization_id;
    const role = req.user!.role;

    if (organization_id && user.role !== "root") {
      const organization = await Organization.findById(organization_id).select("status isActive").lean();
      if (!organization || organization.status === "inactive" || organization.isActive === false) {
        clearAuthCookies(reply);
        return reply.code(403).send(errorResponse("Organization workspace is inactive or suspended"));
      }
    }

    const permissions = [...await getEffectivePermissions(role, organization_id, user.authVersion)];

    const rawImpersonatedBy = req.user?.impersonatedBy;
    const impersonatedBy = (rawImpersonatedBy && rawImpersonatedBy.id) ? {
      id: rawImpersonatedBy.id,
      email: rawImpersonatedBy.email,
      name: rawImpersonatedBy.name,
      originalRole: rawImpersonatedBy.originalRole || "root",
    } : null;

    return reply.code(200).send(successResponse({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        twoFactorEnabled: !!user.twoFactorEnabled,
        mfaEnrollmentRequired: staffMfaEnrollmentRequired(role, !!user.twoFactorEnabled, process.env, Date.now(), !!user.twoFactorEnrollmentRequired),
        role,
        image_url: user.image_url || null,
        organization_id,
        permissions,
        impersonatedBy,
      }
    }, "User fetched successfully"));
  } catch (err) {
    console.error("me error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

// ─── Switch Active Organization (Root Admin Only) ───────────────
export async function switchOrganization(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;

    const { organizationId } = (req.body as any) || {};
    if (userRole !== "root") {
      if (isConsumerRole(userRole) || req.user?.impersonatedBy || !organizationId) {
        return reply.code(403).send(errorResponse("Select a staff organization workspace"));
      }
      const workspace = await authorizeWorkspace(userId, organizationId);
      const user = await User.findOne({ _id: userId, isActive: true });
      if (!user) return reply.code(401).send(errorResponse("Account is unavailable"));
      const session = await createAuthSession({ id: userId, email: user.email || "", role: workspace.role,
        organization_id: organizationId }, { ipAddress: req.ip, userAgent: req.headers["user-agent"], workspaceRole: workspace.role, authenticatedAt: req.primaryAuthenticatedAt || new Date(0) });
      await revokeSessionInternal(req.user!.sessionId!, "terminated");
      setAuthCookies(reply, session.accessToken, session.refreshToken);
      return reply.send(successResponse({ organization_id: organizationId }, "Organization workspace switched"));
    }

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

    const { accessToken, refreshToken } = await createAuthSession(payload, { authenticatedAt: req.primaryAuthenticatedAt || new Date(0) });

    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(200).send(
      successResponse(
        { organization_id: organizationId || null },
        "Organization context switched successfully"
      )
    );
  } catch (err) {
    console.error("switchOrganization error:", safeError(err));
    if (err instanceof WorkspaceError) return reply.code(err.statusCode).send(errorResponse(err.message));
    return reply.code(500).send(errorResponse("Failed to switch organization context"));
  }
}

// ─── Impersonate User ("Login As") (Platform Root Admin Only) ───────
export async function impersonateUser(req: FastifyRequest, reply: FastifyReply) {
  try {
    const callerId = req.user!.id;
    const isRoot = req.user!.role === "root" || req.user!.impersonatedBy?.originalRole === "root";

    if (!isRoot) {
      return reply.code(403).send(errorResponse("Only platform Root Superadmin can impersonate users"));
    }

    const { userId, organizationId, role } = (req.body as any) || {};

    let targetUser: any = null;

    if (userId) {
      if (!mongoose.isValidObjectId(userId)) {
        return reply.code(400).send(errorResponse("Invalid user ID"));
      }
      targetUser = await User.findById(userId);
    } else if (organizationId) {
      if (!mongoose.isValidObjectId(organizationId)) {
        return reply.code(400).send(errorResponse("Invalid organization ID"));
      }
      if (role) {
        const member = await OrgMember.findOne({ organizationId, role }).populate("userId");
        if (member && member.userId) {
          targetUser = member.userId;
        } else {
          targetUser = await User.findOne({ organization_id: organizationId, role });
        }
      } else {
        const member = await OrgMember.findOne({ organizationId, role: "admin" }).populate("userId");
        if (member && member.userId) {
          targetUser = member.userId;
        } else {
          targetUser = await User.findOne({ organization_id: organizationId });
        }
      }
    }

    if (!targetUser) {
      return reply.code(404).send(errorResponse("Target user to impersonate was not found"));
    }

    if (targetUser.isActive === false) {
      return reply.code(400).send(errorResponse("Cannot impersonate an inactive user account"));
    }

    // Determine the original root identity
    const rootAdminId = req.user!.impersonatedBy?.id || callerId;
    const rootAdmin = await User.findById(rootAdminId).select("name email role").lean();
    if (!rootAdmin) {
      return reply.code(403).send(errorResponse("Original root admin record not found"));
    }

    // Determine target user's organization context
    const requestedOrgId = organizationId?.toString();
    if (!requestedOrgId && !isConsumerRole(targetUser.role) && targetUser.role !== "root" &&
      await OrgMember.countDocuments({ userId: targetUser._id }) > 1) {
      return reply.code(409).send(errorResponse("Select an organization before impersonating a multi-workspace account"));
    }
    const orgMember = requestedOrgId
      ? await OrgMember.findOne({ userId: targetUser._id, organizationId: requestedOrgId })
      : await OrgMember.findOne({ userId: targetUser._id });
    if (requestedOrgId && !orgMember && targetUser.organization_id?.toString() !== requestedOrgId) {
      return reply.code(403).send(errorResponse("Target user is not a member of the selected organization"));
    }
    const targetOrgId = requestedOrgId || targetUser.organization_id?.toString() || orgMember?.organizationId?.toString();
    const workspace = targetOrgId && !isConsumerRole(targetUser.role) && targetUser.role !== "root"
      ? await authorizeWorkspace(targetUser.id, targetOrgId) : undefined;
    const targetRole = workspace?.role || targetUser.role;
    const permissions = [...await getEffectivePermissions(targetRole, targetOrgId, targetUser.authVersion)];

    const impersonationData = {
      id: rootAdmin._id.toString(),
      email: rootAdmin.email || "",
      name: rootAdmin.name || "Root Superadmin",
      originalRole: "root",
    };

    const payload: JwtPayload = {
      id: targetUser._id.toString(),
      email: targetUser.email || "",
      role: targetRole,
      organization_id: targetOrgId,
      impersonatedBy: impersonationData,
    };

    const ipAddress = req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser (Impersonation)" : "Desktop Browser (Impersonation)";

    const { accessToken, refreshToken } = await createAuthSession(payload, {
      ipAddress,
      userAgent,
      deviceName,
      organizationId: targetOrgId,
      impersonatedBy: impersonationData,
      workspaceRole: workspace?.role,
    });

    setAuthCookies(reply, accessToken, refreshToken);

    await eventBus.publishDurable({
      eventType: EVENT_TYPES.AUTH_LOGIN_NEW_DEVICE,
      category: "auth",
      targetUserId: targetUser._id.toString(),
      title: "Root Impersonation Session Started",
      message: `Root Superadmin ${rootAdmin.name} (${rootAdmin.email}) entered session as ${targetUser.name} (${targetUser.role}).`,
      severity: "warning",
      organizationId: targetOrgId,
    });

    return reply.code(200).send(
      successResponse(
        {
          user: {
            id: targetUser._id.toString(),
            name: targetUser.name,
            email: targetUser.email,
            role: targetRole,
            organization_id: targetOrgId,
            permissions,
            impersonatedBy: impersonationData,
          },
        },
        `Impersonation active: now signed in as ${targetUser.name} (${targetUser.role})`
      )
    );
  } catch (err: any) {
    console.error("impersonateUser error:", safeError(err));
    return reply.code(500).send(errorResponse(err.message || "Failed to start impersonation session"));
  }
}

// ─── Stop Impersonation & Restore Root Session ─────────────────────
export async function stopImpersonation(req: FastifyRequest, reply: FastifyReply) {
  try {
    let rootAdminId = req.user?.impersonatedBy?.id;

    // Fallback 1: If access token lacks impersonatedBy, check the active RefreshToken in DB
    if (!rootAdminId && req.cookies?.refresh_token) {
      const tokenHash = crypto.createHash("sha256").update(req.cookies.refresh_token).digest("hex");
      const refreshRecord = await RefreshToken.findOne({ tokenHash, revoked: false });
      if (refreshRecord?.impersonatedBy?.id) {
        rootAdminId = refreshRecord.impersonatedBy.id.toString();
      }
    }

    // Fallback 2: If caller is already a root user (e.g. stale banner clicked or already restored)
    if (!rootAdminId && req.user?.role === "root") {
      const rootUser = await User.findById(req.user.id);
      if (rootUser && rootUser.isActive) {
        const ipAddress = req.ip || "";
        const userAgent = (req.headers["user-agent"] as string) || "";
        const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

        const { rawToken: newRefreshToken, sessionId } = await createRefreshTokenDetails(rootUser._id.toString(), {
          ipAddress,
          userAgent,
          deviceName,
          isRoot: true,
        });

        const payload: JwtPayload = {
          id: rootUser._id.toString(),
          email: rootUser.email || "",
          role: "root",
          organization_id: undefined,
          sessionId,
        };

        const accessToken = generateAccessToken(payload);
        setAuthCookies(reply, accessToken, newRefreshToken);

        return reply.code(200).send(
          successResponse(
            {
              user: {
                id: rootUser._id.toString(),
                name: rootUser.name,
                email: rootUser.email,
                role: "root",
                organization_id: undefined,
                permissions: ["*"],
                impersonatedBy: null,
              },
            },
            "Returned to Root Superadmin session"
          )
        );
      }
    }

    if (!rootAdminId) {
      return reply.code(400).send(errorResponse("No active impersonation session found"));
    }

    const rootUser = await User.findById(rootAdminId);
    if (!rootUser || rootUser.role !== "root" || !rootUser.isActive) {
      clearAuthCookies(reply);
      return reply.code(403).send(errorResponse("Unable to restore Root session. Please log in again."));
    }

    // Revoke the impersonation refresh token if present
    if (req.cookies?.refresh_token) {
      const oldHash = crypto.createHash("sha256").update(req.cookies.refresh_token).digest("hex");
      await RefreshToken.updateOne({ tokenHash: oldHash }, { revoked: true, revocationReason: "logout" });
    }

    const ipAddress = req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const { rawToken: newRefreshToken, sessionId } = await createRefreshTokenDetails(rootUser._id.toString(), {
      ipAddress,
      userAgent,
      deviceName,
      isRoot: true,
    });

    const payload: JwtPayload = {
      id: rootUser._id.toString(),
      email: rootUser.email || "",
      role: "root",
      organization_id: undefined,
      sessionId,
    };

    const accessToken = generateAccessToken(payload);
    setAuthCookies(reply, accessToken, newRefreshToken);

    return reply.code(200).send(
      successResponse(
        {
          user: {
            id: rootUser._id.toString(),
            name: rootUser.name,
            email: rootUser.email,
            role: "root",
            organization_id: undefined,
            permissions: ["*"],
            impersonatedBy: null,
          },
        },
        "Returned to Root Superadmin session"
      )
    );
  } catch (err: any) {
    console.error("stopImpersonation error:", safeError(err));
    return reply.code(500).send(errorResponse("Failed to restore Root session"));
  }
}

// ─── Google OAuth & Credential Sign-In ──────────────────────────
export async function googleLoginController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { credential, idToken, token, code, redirectUri } = (req.body as any) || {};
    const candidateToken = credential || idToken || token;

    let profile = null;
    if (candidateToken) {
      profile = await verifyGoogleIdToken(candidateToken);
    } else if (code && redirectUri) {
      profile = await exchangeGoogleAuthCode(code, redirectUri);
    }

    if (!profile) {
      return reply.code(401).send(errorResponse("Invalid Google authentication credentials"));
    }

    const authResult = await authenticateWithGoogleProfile(profile);
    return await completeVerifiedLogin(req, reply, authResult.userRecord,
      { patient: authResult.patient, isNewUser: authResult.isNewUser });
  } catch (err: any) {
    console.error("googleLoginController error:", safeError(err));
    return reply.code(400).send(errorResponse(err.message || "Failed to authenticate with Google"));
  }
}


// Shared session issuance for verified passwords and passkeys; existing 2FA remains required.
export async function completeVerifiedLogin(req: FastifyRequest, reply: FastifyReply, user: any,
  extra: Record<string, unknown> = {}, mfaVerified = false, selectedOrganizationId?: string) {
    if (!user.isActive) return reply.code(403).send(errorResponse("Account is deactivated"));
    if (process.env.NODE_ENV === "production" && user.role === "root" && !user.twoFactorEnabled) return reply.code(403).send(errorResponse("Platform root MFA enrollment is required. Use the authorized recovery/setup procedure."));
    if (user.twoFactorEnabled && !mfaVerified) {
      if (!user.twoFactorSecret) return reply.code(403).send(errorResponse("Two-factor configuration requires account recovery"));
      clearAuthCookies(reply);
      const twoFactorToken = generateTwoFactorChallenge(user.id, user.authVersion || 1);
      return reply.code(200).send(
        successResponse(
          {
            twoFactorRequired: true,
            twoFactorToken,
            user: { id: user.id, name: user.name, email: user.email, role: user.role },
          },
          "Two-factor verification required"
        )
      );
    }

    let organization_id: string | undefined;
    let role = user.role as string;
    if (role !== "root" && !isConsumerRole(role)) {
      const workspaces = await listUserWorkspaces(user.id);
      if (!selectedOrganizationId && workspaces.length > 1) {
        clearAuthCookies(reply);
        const workspaceToken = await createWorkspaceChallenge(user.id, user.authVersion || 1, Boolean(user.twoFactorEnabled));
        return reply.send(successResponse({ workspaceRequired: true, workspaceToken, workspaces }, "Select your organization workspace"));
      }
      organization_id = selectedOrganizationId || workspaces[0]?.organizationId;
      if (organization_id) role = (await authorizeWorkspace(user.id, organization_id)).role;
      else if (await OrgMember.exists({ userId: user._id })) {
        return reply.code(403).send(errorResponse("No active organization workspace is available"));
      }
    }
    const permissions = [...await getEffectivePermissions(role, organization_id, user.authVersion)];

    // Extract device metadata for session tracking
    const ipAddress = req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const { rawToken: refreshToken, sessionId } = await createRefreshTokenDetails(user.id, {
      ipAddress,
      userAgent,
      deviceName,
      organizationId: organization_id,
      isRoot: user.role === "root",
      workspaceRole: organization_id ? role : undefined,
    });

    const payload = { id: user.id, email: user.email || "", role, organization_id, sessionId, authVersion: user.authVersion || 1 };
    const accessToken = generateAccessToken(payload);

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

    // Emit authentication notification event
    await eventBus.publishDurable({
      eventType: EVENT_TYPES.AUTH_LOGIN_NEW_DEVICE,
      category: "auth",
      targetUserId: user.id,
      title: "New Account Login",
      message: `Successful login to Ekavyu account (${user.email || user.name}).`,
      severity: "info",
      organizationId: organization_id,
    });

    return reply.code(200).send(
      successResponse(
        {
          ...extra,
          user: { id: user.id, name: user.name, email: user.email || null, role, image_url: user.image_url || null, organization_id, permissions, twoFactorEnabled: !!user.twoFactorEnabled, mfaEnrollmentRequired: staffMfaEnrollmentRequired(role, !!user.twoFactorEnabled, process.env, Date.now(), !!user.twoFactorEnrollmentRequired) },
        },
        "Login successful"
      )
    );
}

export async function selectLoginWorkspace(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { workspaceToken, organizationId } = req.body as { workspaceToken: string; organizationId: string };
    const challenge = await readWorkspaceChallenge(workspaceToken);
    const user = await User.findOne({ _id: challenge.userId, isActive: true });
    if (!user || user.role === "root" || isConsumerRole(user.role) ||
      (user.authVersion || 1) !== challenge.authVersion || Boolean(user.twoFactorEnabled) !== challenge.mfaEnabled) {
      return reply.code(401).send(errorResponse("Account changed; sign in again"));
    }
    await authorizeWorkspace(user.id, organizationId);
    await consumeWorkspaceChallenge(String(challenge._id));
    return await completeVerifiedLogin(req, reply, user, {}, true, organizationId);
  } catch (error) {
    if (error instanceof WorkspaceError) return reply.code(error.statusCode).send(errorResponse(error.message));
    req.log.error("Workspace selection failed");
    return reply.code(503).send(errorResponse("Workspace selection unavailable; sign in again"));
  }
}

export async function getUserWorkspaces(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user || req.user.role === "root" || isConsumerRole(req.user.role) || req.user.impersonatedBy) {
    return reply.code(403).send(errorResponse("Sign in to your own staff account to select a workspace"));
  }
  return reply.send(successResponse(await listUserWorkspaces(req.user.id)));
}


async function replyWithRotationGrace(reply: FastifyReply, previous: any) {
  // A concurrent refresh must use the live successor, never the revoked session.
  let successor: any = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    successor = await RefreshToken.findOne({ userId: previous.userId, familyId: previous.familyId, generation: { $gt: previous.generation || 1 }, revoked: false, expiresAt: { $gt: new Date() } }).sort({ generation: -1 }).lean();
    if (successor) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const user = await User.findById(previous.userId).select("role email isActive authVersion").lean();
  if (!successor || !user?.isActive || successor.authVersion !== (user.authVersion || 1)) {
    return reply.code(401).send(errorResponse("Session has expired or been terminated"));
  }
  const organization_id = successor.organizationId?.toString();
  const workspace = organization_id && user.role !== "root" && !isConsumerRole(user.role) && !successor.isGuest
    ? await authorizeWorkspace(String(user._id), organization_id) : undefined;
  if (successor.workspaceRole && successor.workspaceRole !== workspace?.role) return reply.code(401).send(errorResponse("Workspace membership changed; sign in again"));
  const liveSession = await resolveSession(String(successor._id), user.authVersion || 1);
  if (!liveSession.valid) return reply.code(401).send(errorResponse("Workspace session changed; sign in again"));
  if (organization_id && user.role !== "root") {
    const organization = await Organization.findById(organization_id).select("status isActive").lean();
    if (!organization || organization.status === "inactive" || organization.isActive === false) return reply.code(403).send(errorResponse("Organization workspace is inactive or suspended"));
  }
  const payload: JwtPayload = { id: user._id.toString(), email: user.email || "", role: successor.isGuest ? "guest" : workspace?.role || user.role,
    organization_id, sessionId: successor._id.toString(), authVersion: user.authVersion || 1, bookingPatientId: successor.bookingPatientId?.toString() };
  if (successor.impersonatedBy?.id) payload.impersonatedBy = { ...successor.impersonatedBy, id: successor.impersonatedBy.id.toString() };
  setAccessCookie(reply, generateAccessToken(payload));
  reply.header("X-Concurrency-Grace", "true");
  return reply.send(successResponse(null, "Token refreshed within concurrency grace window"));
}

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
  createRefreshTokenDetails,
  validateRefreshToken,
  revokeAllRefreshTokens,
  revokeSessionCache,
  successResponse,
  errorResponse,
  generateTwoFactorChallenge,
  verifyTwoFactorChallenge,
  normalizePhone,
} from "../utilities/helpers.ts";
import { setAuthCookies, clearAuthCookies, type JwtPayload } from "../utilities/types.ts";
import { resolveSession, revokeSession, revokeUserSessions, revokeTokenFamily } from "../utilities/sessionResolver.ts";
import { disconnectUserWebSockets } from "../notifications/websocket.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";

import crypto from "node:crypto";
import { validatePasswordStrength } from "../middleware/auth.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { enqueueTransactionalEmail } from "../services/CommunicationOutbox.ts";
import { TwoFactorService } from "../services/TwoFactorService.ts";
import { otpService } from "../services/OtpService.ts";
import { patientMatchingService } from "../services/PatientMatchingService.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import mongoose from "mongoose";
import { encrypt, decrypt, isEncrypted } from "../utilities/encryption.ts";
import { verifyGoogleIdToken, authenticateWithGoogleProfile, exchangeGoogleAuthCode } from "../services/GoogleAuthService.ts";
import { getFrontendBaseUrl } from "../utilities/config.ts";

// ─── Request OTP ────────────────────────────────────────────────
export async function requestOtpController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { phone, email, purpose } = req.body as {
      phone?: string;
      email?: string;
      purpose?: "authentication" | "phone_verification" | "email_verification" | "record_claim";
    };

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
    console.error("requestOtpController error:", err);
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

    // Check if email is already claimed by an existing User
    const existingUserWithEmail = emailInput ? await User.findOne({ email: emailInput }) : null;

    if (!user) {
      // If no user found by phone, check if the email belongs to a patient account that has no phone attached
      if (existingUserWithEmail && existingUserWithEmail.role === "patient" && !existingUserWithEmail.phone) {
        existingUserWithEmail.phone = normPhone;
        if (existingUserWithEmail.name.startsWith("Patient ")) {
          existingUserWithEmail.name = nameInput;
        }
        await existingUserWithEmail.save();
        user = existingUserWithEmail;
      } else {
        isNewUser = true;
        // Only set email on User document if it's not already claimed by another User account (avoiding E11000)
        const emailForUser = (emailInput && !existingUserWithEmail) ? emailInput : undefined;
        user = await User.create({
          name: nameInput,
          phone: normPhone,
          email: emailForUser,
          role: "patient",
          authMethod: "phone_otp",
          isEmailVerified: false,
        });
      }
    } else {
      // Security: Do NOT overwrite verified name/email from an unauthenticated guest flow.
      // Only set name if the account was registered with a temporary placeholder name.
      let changed = false;
      if (nameInput && user.name.startsWith("Patient ")) {
        user.name = nameInput;
        changed = true;
      }
      // Only set email on User if user has no email AND email is not taken by another user
      if (emailInput && !user.email) {
        if (!existingUserWithEmail || existingUserWithEmail._id.equals(user._id)) {
          user.email = emailInput;
          changed = true;
        }
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

    if (patient && patient.name.startsWith("Patient ")) {
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
    }

    // Scoped Guest Session: Under no circumstance do we grant unauthenticated access to the full 'patient' role
    // or longitudinal EHR records. Guest callers receive a scoped 'guest' session strictly for the current booking.
    const scopedRole = "guest";
    const guestPermissions = ["CREATE_APPOINTMENTS"];

    const payload = {
      id: user.id,
      email: user.email || "",
      role: scopedRole,
      organization_id: (user as any).organization_id,
      permissions: guestPermissions,
    };
    const accessToken = generateAccessToken(payload);
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const refreshToken = await createRefreshToken(user.id, {
      ipAddress,
      userAgent,
      deviceName,
      isGuest: true,
    });
    setAuthCookies(reply, accessToken, refreshToken);

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
    console.error("createPublicBookingSession error:", err);
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
    const normPhone = trimmedPhone ? normalizePhone(trimmedPhone) : undefined;
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
      if (!user) {
        user = await User.findOne({ phone: { $in: [`+91${normPhone}`, `91${normPhone}`] } });
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

    if (!patient && normEmail) {
      patient = await Patient.findOne({ email: normEmail });
      if (patient && !patient.userId) {
        patient.userId = user._id;
        await patient.save();
      }
    }

    // If patient is found and has a generic or empty name, sync with input
    if (patient && nameInput && (patient.name.startsWith("Patient ") || patient.accountType === "self")) {
      patient.name = nameInput;
      await patient.save();
    }

    // Check for high-confidence matching unlinked clinic records if patient doesn't exist
    let potentialMatch: any = null;
    if (!patient) {
      const matchCriteria: any = { name: nameInput || user.name };
      if (normPhone) matchCriteria.phone = normPhone;
      if (normEmail) matchCriteria.email = normEmail;
      const matches = await patientMatchingService.findMatchingPatients(matchCriteria);
      if (matches.highConfidence.length > 0) {
        potentialMatch = matches.highConfidence[0];
      }
    }

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
      // Increment failed attempts & lockout if >= 5 atomically (Finding: Step 2.8)
      const updatedUser = await User.findOneAndUpdate(
        { _id: user._id },
        { $inc: { failedLoginAttempts: 1 } },
        { new: true, returnDocument: "after" }
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

    // Extract device metadata for session tracking
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const { rawToken: refreshToken, sessionId } = await createRefreshTokenDetails(user.id, {
      ipAddress,
      userAgent,
      deviceName,
      organizationId: organization_id,
      isRoot: user.role === "root",
    });

    const payload = { id: user.id, email: user.email || "", role: user.role, organization_id, sessionId };
    const accessToken = generateAccessToken(payload);

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

    // Emit authentication notification event
    await eventBus.publishDurable({
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
          user: { id: user.id, name: user.name, email: user.email || null, role: user.role, image_url: user.image_url || null, organization_id, permissions },
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
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";
    const { rawToken: refreshToken, sessionId } = await createRefreshTokenDetails(user.id, {
      ipAddress,
      userAgent,
      deviceName,
      organizationId: organization_id,
      isRoot: user.role === "root",
    });

    const payload = { id: user.id, email: user.email || "", role: user.role, organization_id, sessionId };
    const accessToken = generateAccessToken(payload);

    setAuthCookies(reply, accessToken, refreshToken);
    await eventBus.publishDurable({
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

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      $or: [
        { emailVerificationToken: tokenHash },
        { emailVerificationToken: token }, // backwards-compatible with legacy unhashed tokens
      ],
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
      subject: "ANANT Account Password Reset",
      text: `Reset your ANANT password using this link (valid for 1 hour): ${resetUrl}`,
      html: `<p>Click here to reset your ANANT password: <a href="${resetUrl}">${resetUrl}</a></p>`,
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
      $or: [
        { passwordResetToken: tokenHash },
        { passwordResetToken: token }, // backwards-compatible with legacy unhashed tokens
      ],
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
    revokeSessionCache(sessionId);

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
    console.error("getAdminAllSessions error:", err);
    return reply.code(500).send(errorResponse("Failed to fetch active platform sessions"));
  }
}

// ─── Root Superadmin: Terminate a Specific Session ───────────────
export async function adminRevokeSession(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { sessionId } = req.params as { sessionId: string };
    await revokeSession(sessionId, "admin_revocation");
    return reply.send(successResponse(null, "Session terminated successfully"));
  } catch (err: any) {
    console.error("adminRevokeSession error:", err);
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
    console.error("adminRevokeUserSessions error:", err);
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
      if (currentRecord.graceExpiresAt && new Date(currentRecord.graceExpiresAt).getTime() > now) {
        const user = await User.findById(currentRecord.userId).select("role authVersion isActive email").lean();
        if (!user || !user.isActive) {
          clearAuthCookies(reply);
          return reply.code(401).send(errorResponse("User account deactivated"));
        }
        const authVersion = (user as any).authVersion || 1;
        const payload: JwtPayload = {
          id: user._id.toString(),
          email: user.email || "",
          role: user.role,
          organization_id: currentRecord.organizationId?.toString(),
          sessionId: currentRecord._id.toString(),
          authVersion,
        };
        const accessToken = generateAccessToken(payload);
        reply.header("X-Concurrency-Grace", "true");
        return reply.code(200).send(successResponse(null, "Token refreshed within concurrency grace window"));
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

    const orgMember = await OrgMember.findOne({ userId: user._id });
    const organization_id = currentRecord.organizationId?.toString() || orgMember?.organizationId?.toString();
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
      { new: false }
    );

    if (!consumed) {
      // Race condition or concurrent update occurred
      const recheck = await RefreshToken.findById(currentRecord._id);
      if (recheck?.graceExpiresAt && new Date(recheck.graceExpiresAt).getTime() > Date.now()) {
        const payload: JwtPayload = {
          id: user._id.toString(),
          email: user.email || "",
          role: user.role,
          organization_id,
          sessionId: currentRecord._id.toString(),
          authVersion: (user as any).authVersion || 1,
        };
        const accessToken = generateAccessToken(payload);
        return reply.code(200).send(successResponse(null, "Token refreshed within concurrency grace window"));
      }
      clearAuthCookies(reply);
      return reply.code(401).send(errorResponse("Token rotation collision. Please sign in again."));
    }

    // Issue new rotated refresh token + access token only AFTER successful atomic consumption
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || currentRecord.ipAddress;
    const userAgent = (req.headers["user-agent"] as string) || currentRecord.userAgent;
    const deviceName = currentRecord.deviceName || (userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser");
    const isGuestToken = (currentRecord as any).isGuest === true;
    const targetRole = isGuestToken ? "guest" : user.role;

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
      isRoot: user.role === "root",
      familyId: currentRecord.familyId || crypto.randomUUID(),
      generation: nextGeneration,
      authVersion,
      impersonatedBy: validImpersonatedBy,
    });

    const newHash = crypto.createHash("sha256").update(newRefreshToken).digest("hex");
    await RefreshToken.updateOne({ _id: currentRecord._id }, { $set: { replacedByTokenHash: newHash } });

    const payload: JwtPayload = {
      id: user.id,
      email: user.email || "",
      role: targetRole,
      organization_id,
      sessionId,
      authVersion,
    };
    if (validImpersonatedBy) {
      payload.impersonatedBy = validImpersonatedBy;
    }
    const accessToken = generateAccessToken(payload);

    setAuthCookies(reply, accessToken, newRefreshToken);
    return reply.code(200).send(successResponse(null, "Token refreshed"));
  } catch (err) {
    console.error("refreshAccessToken error:", err);
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
        await revokeSession(record._id.toString(), "logout");
      }
    }

    if (sessionId) {
      await revokeSession(sessionId, "logout");
    }

    if (userId) {
      disconnectUserWebSockets(userId, 4001, "User logged out");
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
    const emailVerificationTokenHash = crypto.createHash("sha256").update(emailVerificationToken).digest("hex");

    const newUser = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      phone: phone || null,
      role: "patient",
      isEmailVerified: false,
      emailVerificationToken: emailVerificationTokenHash,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    try {
      await Patient.create({
        userId: newUser._id,
        name: name.trim(),
        phone: phone || null,
        email: normalizedEmail,
        organizationId: selectedClinic?.organizationId,
      });
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

    const verificationUrl = `${getFrontendBaseUrl()}/verify-email#token=${emailVerificationToken}`;
    await enqueueTransactionalEmail({
      to: normalizedEmail,
      subject: "Verify your ANANTA account",
      text: `Verify your account using this link (valid for 24 hours): ${verificationUrl}`,
      html: `<p>Verify your ANANTA account: <a href="${verificationUrl}">${verificationUrl}</a></p>`,
      idempotencyKey: `transactional-email:email-verification:${newUser._id}:${emailVerificationTokenHash}`,
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
        role: user.role,
        image_url: user.image_url || null,
        organization_id,
        permissions,
        impersonatedBy,
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
    const orgMember = await OrgMember.findOne({ userId: targetUser._id });
    const targetOrgId = targetUser.organization_id?.toString() || orgMember?.organizationId?.toString();

    const roleConfig = await Role.findOne({ name: targetUser.role }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    const impersonationData = {
      id: rootAdmin._id.toString(),
      email: rootAdmin.email || "",
      name: rootAdmin.name || "Root Superadmin",
      originalRole: "root",
    };

    const payload: JwtPayload = {
      id: targetUser._id.toString(),
      email: targetUser.email || "",
      role: targetUser.role,
      organization_id: targetOrgId,
      impersonatedBy: impersonationData,
    };

    const accessToken = generateAccessToken(payload);
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser (Impersonation)" : "Desktop Browser (Impersonation)";

    const refreshToken = await createRefreshToken(targetUser._id.toString(), {
      ipAddress,
      userAgent,
      deviceName,
      organizationId: targetOrgId,
      impersonatedBy: impersonationData,
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
            role: targetUser.role,
            organization_id: targetOrgId,
            permissions,
            impersonatedBy: impersonationData,
          },
        },
        `Impersonation active: now signed in as ${targetUser.name} (${targetUser.role})`
      )
    );
  } catch (err: any) {
    console.error("impersonateUser error:", err);
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
        const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
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

    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
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
    console.error("stopImpersonation error:", err);
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

    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const authResult = await authenticateWithGoogleProfile(profile, { ipAddress, userAgent, deviceName });

    setAuthCookies(reply, authResult.accessToken, authResult.refreshToken);

    return reply.code(200).send(
      successResponse(
        {
          user: authResult.user,
          patient: authResult.patient,
          isNewUser: authResult.isNewUser,
        },
        "Google authentication successful"
      )
    );
  } catch (err: any) {
    console.error("googleLoginController error:", err);
    return reply.code(400).send(errorResponse(err.message || "Failed to authenticate with Google"));
  }
}

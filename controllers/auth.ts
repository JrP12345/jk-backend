import type { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { Organization } from "../models/Organization.ts";
import { Patient } from "../models/Patient.ts";
import { Role } from "../models/Role.ts";
import {
  generateAccessToken,
  createRefreshToken,
  validateRefreshToken,
  revokeAllRefreshTokens,
  successResponse,
  errorResponse,
} from "../utilities/helpers.ts";
import { setAuthCookies, clearAuthCookies } from "../utilities/types.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";

import crypto from "node:crypto";
import { validatePasswordStrength } from "../middleware/auth.ts";
import { RefreshToken } from "../models/RefreshToken.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";

// ─── Login ──────────────────────────────────────────────────────
export async function login(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { email, password } = req.body as { email: string; password: string };

    if (!email || !password) {
      return reply.code(400).send(errorResponse("Email and password are required"));
    }

    const user = await User.findOne({ email });

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

    const payload = { id: user.id, email: user.email, role: user.role, organization_id };
    const accessToken = generateAccessToken(payload);

    // Extract device metadata for session tracking
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "";
    const userAgent = (req.headers["user-agent"] as string) || "";
    const deviceName = userAgent.includes("Mobile") ? "Mobile App / Browser" : "Desktop Browser";

    const refreshToken = await createRefreshToken(user.id, { ipAddress, userAgent, deviceName });

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

    // Emit authentication notification event
    eventBus.publish({
      eventType: EVENT_TYPES.AUTH_LOGIN_NEW_DEVICE,
      category: "auth",
      targetUserId: user.id,
      title: "New Account Login",
      message: `Successful login to Ananta account (${user.email}).`,
      severity: "info",
      organizationId: organization_id,
    });

    return reply.code(200).send(
      successResponse(
        {
          user: { id: user.id, name: user.name, email: user.email, role: user.role, organization_id, permissions },
        },
        "Login successful"
      )
    );
  } catch (err) {
    console.error("login error:", err);
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
      return reply.send(successResponse(null, "If an account exists with that email, a password reset link has been dispatched."));
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    user.set("passwordResetToken", resetToken);
    user.set("passwordResetExpires", expires);
    await user.save();

    const resetUrl = `${process.env.CORS_ALLOWED_ORIGINS || "http://localhost:3000"}/reset-password?token=${resetToken}`;
    await emailProvider.sendEmail({
      to: user.email,
      subject: "ANANTA Account Password Reset",
      text: `Reset your ANANTA password using this link (valid for 1 hour): ${resetUrl}`,
      html: `<p>Click here to reset your password: <a href="${resetUrl}">${resetUrl}</a></p>`,
    });

    return reply.send(successResponse(null, "Password reset instructions sent to your email."));
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



// ─── Refresh Access Token ───────────────────────────────────────
export async function refreshAccessToken(req: FastifyRequest, reply: FastifyReply) {
  try {
    // Read refresh token from httpOnly cookie
    const rawRefreshToken = req.cookies?.refresh_token;
    if (!rawRefreshToken) {
      return reply.code(401).send(errorResponse("Missing refresh token"));
    }

    const userId = await validateRefreshToken(rawRefreshToken);
    if (!userId) {
      return reply.code(401).send(errorResponse("Invalid or expired refresh token"));
    }

    const user = await User.findOne({ _id: userId, isActive: true });

    if (!user) {
      return reply.code(401).send(errorResponse("User not found or deactivated"));
    }

    const orgMember = await OrgMember.findOne({ userId: user._id });
    const organization_id = orgMember?.organizationId?.toString();

    const payload = { id: user.id, email: user.email, role: user.role, organization_id };
    const accessToken = generateAccessToken(payload);

    // Update the access token cookie only
    reply.setCookie("access_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60,
    });

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
    const { name, email, password, phone } = req.body as {
      name: string;
      email: string;
      password: string;
      phone?: string;
    };

    if (!name || !email || !password) {
      return reply.code(400).send(errorResponse("Name, email and password are required"));
    }

    const exists = await User.findOne({ email });
    if (exists) {
      return reply.code(409).send(errorResponse("Email already registered"));
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await User.create({
      name,
      email,
      password: hashedPassword,
      phone: phone || null,
      role: "patient",
    });

    try {
      await Patient.create({ userId: newUser._id });
    } catch (err) {
      await User.deleteOne({ _id: newUser._id });
      throw err;
    }

    const roleConfig = await Role.findOne({ name: "patient" }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    const payload = { id: newUser.id, email, role: "patient" };
    const accessToken = generateAccessToken(payload);
    const refreshToken = await createRefreshToken(newUser.id);

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

    return reply.code(201).send(
      successResponse(
        { user: { id: newUser.id, name, email, role: "patient", permissions } },
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

    const payload = {
      id: userId,
      email: req.user!.email,
      role: "root",
      organization_id: organizationId || undefined,
    };

    const accessToken = generateAccessToken(payload);
    const refreshToken = await createRefreshToken(userId);

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

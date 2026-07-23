import type { FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { User } from "../models/User.ts";
import { OrgMember } from "../models/OrgMember.ts";
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

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return reply.code(401).send(errorResponse("Invalid credentials"));
    }

    const orgMember = await OrgMember.findOne({ userId: user._id });
    const organization_id = orgMember?.organizationId?.toString();

    const roleConfig = await Role.findOne({ name: user.role }).lean() as any;
    const permissions = roleConfig ? roleConfig.permissions : [];

    const payload = { id: user.id, email: user.email, role: user.role, organization_id };
    const accessToken = generateAccessToken(payload);
    const refreshToken = await createRefreshToken(user.id);

    // Set httpOnly cookies
    setAuthCookies(reply, accessToken, refreshToken);

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
    const organization_id = orgMember?.organizationId?.toString();

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

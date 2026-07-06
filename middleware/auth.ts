import type { FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { User } from "../models/User.ts";
import { Role } from "../models/Role.ts";
import { verifyAccessToken } from "../utilities/helpers.ts";
import type { JwtPayload } from "../utilities/types.ts";
import { requestContextStore } from "../utilities/context.ts";

// Extend FastifyRequest to carry the decoded user
declare module "fastify" {
  interface FastifyRequest {
    user?: JwtPayload;
  }
}

/**
 * Asymmetric JWT authentication middleware.
 *
 * Reads the access token from the `access_token` httpOnly cookie.
 * Flow:
 *  1. Read token from cookie.
 *  2. Decode WITHOUT verifying to extract `id`.
 *  3. Fetch user's RSA public key from DB.
 *  4. Verify the RS256 signature.
 *  5. Attach verified payload to `req.user`.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    const token = req.cookies?.access_token;
    if (!token) {
      return reply.code(401).send({ error: "Missing access token" });
    }

    // Step 1: decode without verifying to extract user id
    const unverified = jwt.decode(token) as JwtPayload | null;
    if (!unverified || !unverified.id) {
      return reply.code(401).send({ error: "Malformed token" });
    }

    // Step 2: fetch the user's public key from DB
    const user = await User.findOne({ _id: unverified.id, isActive: true });

    if (!user) {
      return reply.code(401).send({ error: "User not found or deactivated" });
    }

    // Step 3: verify signature with user's public key
    const decoded = verifyAccessToken(token, user.publicKey);
    req.user = decoded;

    // Set the context userId for audit logging
    const context = requestContextStore.getStore();
    if (context) {
      context.userId = decoded.id;
    }
  } catch {
    return reply.code(401).send({ error: "Invalid or expired token" });
  }
}

/**
 * Factory: restrict access to specific roles.
 * Usage: { preHandler: [authenticate, authorize("admin")] }
 */
export function authorize(...allowedRoles: string[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return reply.code(403).send({ error: "Forbidden: insufficient permissions" });
    }
  };
}

/**
 * Factory: restrict access to specific permissions.
 * Usage: { preHandler: [authenticate, checkPermission("MANAGE_STAFF")] }
 */
export function checkPermission(requiredPermission: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !req.user.role) {
      return reply.code(403).send({ error: "Forbidden: role not configured" });
    }

    // Admins bypass all permission checks
    if (req.user.role === "admin") {
      return;
    }

    const roleConfig = await Role.findOne({ name: req.user.role }).lean() as any;
    if (!roleConfig || !roleConfig.permissions.includes(requiredPermission)) {
      return reply.code(403).send({ error: "Forbidden: insufficient permissions" });
    }
  };
}

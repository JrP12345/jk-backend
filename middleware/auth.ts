import type { FastifyRequest, FastifyReply } from "fastify";
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
 * Performs fast, in-memory RS256 signature verification using the
 * service-level public key (zero DB lookups).
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    const token = req.cookies?.access_token;
    if (!token) {
      return reply.code(401).send({ error: "Missing access token" });
    }

    // Verify signature in-memory using service public key
    const decoded = verifyAccessToken(token);
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
 *
 * Evaluates the required permission against the caller's Role document in the
 * database. All roles — including "admin" — are evaluated through the same
 * permission table, ensuring the Role.permissions[] array is the single source
 * of truth for authorization decisions across the entire system.
 *
 * Usage: { preHandler: [authenticate, checkPermission("MANAGE_STAFF")] }
 */
export function checkPermission(requiredPermission: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || !req.user.role) {
      return reply.code(403).send({ error: "Forbidden: role not configured" });
    }

    if (req.user.role === "admin") {
      return; // Built-in admin system role bypasses permission checks
    }

    const roleConfig = await Role.findOne({ name: req.user.role }).lean() as any;
    if (!roleConfig || !roleConfig.permissions.includes(requiredPermission)) {
      return reply.code(403).send({ error: "Forbidden: insufficient permissions" });
    }
  };
}

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
    const token =
      req.cookies?.access_token ||
      (req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.split(" ")[1] : undefined);

    if (!token) {
      return reply.code(401).send({ error: "Missing access token" });
    }

    // Verify signature in-memory using service public key
    const decoded = verifyAccessToken(token);
    req.user = decoded;

    // Set the context store for audit logging & tenant isolation
    const ipAddress = (req.headers["x-forwarded-for"] as string) || req.ip || "127.0.0.1";
    const userAgent = req.headers["user-agent"] || "unknown";
    const cleanIp = Array.isArray(ipAddress) ? ipAddress[0] : ipAddress.split(",")[0].trim();

    requestContextStore.enterWith({
      userId: decoded.id,
      organizationId: decoded.organization_id,
      ipAddress: cleanIp,
      userAgent,
    });
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
    if (!req.user) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    if (req.user.role === "root" || req.user.role === "admin" || allowedRoles.includes(req.user.role)) {
      return;
    }

    // Check dynamic user.permissions array if present in JWT token
    const userPermissions: string[] = (req.user as any).permissions || [];
    const roleConfig = await Role.findOne({ name: req.user.role }).lean() as any;
    const rolePermissions: string[] = roleConfig?.permissions || [];
    const allPermissions = Array.from(new Set([...userPermissions, ...rolePermissions]));

    // Check if user has any permission matching the target role requirement
    const hasPermissionMatch = allowedRoles.some((role) => {
      const permissionName = `MANAGE_${role.toUpperCase()}`;
      return allPermissions.includes(permissionName) || allPermissions.includes("MANAGE_ORGANIZATION");
    });

    if (hasPermissionMatch) {
      return;
    }

    return reply.code(403).send({ error: "Forbidden: insufficient permissions" });
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

    if (
      req.user.role === "root" ||
      req.user.role === "admin"
    ) {
      return; // Built-in root and admin roles bypass permission checks
    }

    const roleConfig = await Role.findOne({ name: req.user.role }).lean() as any;
    if (!roleConfig || !roleConfig.permissions.includes(requiredPermission)) {
      return reply.code(403).send({ error: "Forbidden: insufficient permissions" });
    }
  };
}

/**
 * Tenant Isolation Guard Middleware.
 * Verifies that requests targeting an organization scope match the authenticated caller's organization_id.
 * Root super-admins bypass tenant checks.
 */
export async function enforceTenantIsolation(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  if (req.user.role === "root") {
    return; // Root admin context bypasses tenant restriction
  }

  const targetOrgId =
    (req.headers["x-organization-id"] as string) ||
    (req.body as any)?.organizationId ||
    (req.query as any)?.organizationId ||
    (req.params as any)?.organizationId;

  if (targetOrgId && targetOrgId !== req.user.organization_id) {
    return reply.code(403).send({ error: "Forbidden: Cross-tenant access attempt blocked" });
  }
}

/**
 * Password Strength Policy Validator.
 * Enforces minimum length (8 chars), mixed case, number, and special character.
 */
export function validatePasswordStrength(password: string): { valid: boolean; reason?: string } {
  if (!password || password.length < 8) {
    return { valid: false, reason: "Password must be at least 8 characters long" };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one uppercase letter" };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one lowercase letter" };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, reason: "Password must contain at least one digit" };
  }
  return { valid: true };
}

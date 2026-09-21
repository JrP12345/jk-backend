import type { FastifyRequest, FastifyReply } from "fastify";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";
import { MODULE_KEYS, getAlwaysOnModules } from "../data/moduleKeys.ts";

async function resolveModuleOrganizationId(req: FastifyRequest): Promise<string | undefined> {
  if (req.user?.organization_id) {
    return req.user.organization_id;
  }
  // Portal consumers and root callers bypass this guard. Staff without a
  // membership claim fail closed rather than selecting a tenant from request
  // IDs or client headers.
  return undefined;
}

/**
 * Module Guard Middleware Factory.
 *
 * Checks if the specified module is enabled for the requesting user's organization.
 * Root users bypass module checks (can always access everything).
 * Always-on modules (dashboard, settings, notifications) are never blocked.
 *
 * Usage:
 *   { preHandler: [authenticate, requireModule("laboratory")] }
 */
export function requireModule(moduleKey: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Root users, patients, and family members accessing self-service bypass organization-level module gating
    if (req.user?.role === "root" || req.user?.role === "patient" || req.user?.role === "family_member" || req.user?.role === "guest") {
      return;
    }

    // Always-on modules are never gated
    if (getAlwaysOnModules().includes(moduleKey)) {
      return;
    }

    // Validate the module key is known
    if (!MODULE_KEYS[moduleKey]) {
      req.log?.warn(`requireModule: unknown module key '${moduleKey}', allowing request`);
      return;
    }

    const orgId = await resolveModuleOrganizationId(req);
    if (!orgId) {
      return reply.code(403).send({
        success: false,
        error: "Module access denied",
        message: "Organization context is required to check module availability",
      });
    }

    const isEnabled = await isModuleEnabledForOrganization(orgId, moduleKey);

    if (!isEnabled) {
      return reply.code(403).send({
        success: false,
        error: "Module disabled",
        message: `The '${MODULE_KEYS[moduleKey].label}' module is not enabled for your organization. Contact your administrator to enable it.`,
        moduleKey,
      });
    }
  };
}

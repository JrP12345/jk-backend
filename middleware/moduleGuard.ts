import type { FastifyRequest, FastifyReply } from "fastify";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { MODULE_KEYS, getAlwaysOnModules } from "../data/moduleKeys.ts";

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
    // Root users bypass module restrictions
    if (req.user?.role === "root") {
      return;
    }

    // Always-on modules are never gated
    const alwaysOn = getAlwaysOnModules();
    if (alwaysOn.includes(moduleKey)) {
      return;
    }

    // Validate the module key is known
    if (!MODULE_KEYS[moduleKey]) {
      // Unknown module key — allow request but log warning
      req.log?.warn(`requireModule: unknown module key '${moduleKey}', allowing request`);
      return;
    }

    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(403).send({
        success: false,
        error: "Module access denied",
        message: "Organization context is required to check module availability",
      });
    }

    const record = await ModuleRegistry.findOne({
      organizationId: orgId,
      moduleKey,
    }).lean();

    // If no record exists, default to the module's priority-based default
    // P1 modules default to enabled, P2/P3 default to disabled
    const isEnabled = record
      ? (record as any).enabled
      : MODULE_KEYS[moduleKey].priority === "P1";

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

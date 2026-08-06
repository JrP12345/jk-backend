import type { FastifyRequest, FastifyReply } from "fastify";
import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { MODULE_KEYS, getAlwaysOnModules } from "../data/moduleKeys.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// ─── GET /api/modules — List all modules for current org ─────────
export async function getModules(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      // Fallback for Root Admin / pre-onboarding context: Return default P1 modules enabled
      const defaultList = Object.entries(MODULE_KEYS).map(([key, def]) => ({
        moduleKey: key,
        enabled: def.priority === "P1",
        label: def.label,
        priority: def.priority,
        category: def.priority === "P1" ? "core" : def.priority === "P2" ? "addon" : "specialty",
        route: def.route,
        description: def.description,
        section: def.section,
        alwaysOn: def.alwaysOn || false,
      }));
      return reply.send(successResponse(defaultList, "Default modules retrieved"));
    }

    let modules = await ModuleRegistry.find({ organizationId: orgId })
      .sort({ priority: 1, label: 1 })
      .lean();

    // If no modules exist yet, seed them automatically (first-time access)
    if (modules.length === 0) {
      await seedModulesForOrg(orgId);
      modules = await ModuleRegistry.find({ organizationId: orgId })
        .sort({ priority: 1, label: 1 })
        .lean();
    }

    // Enrich with metadata from MODULE_KEYS
    const enriched = modules.map((mod: any) => {
      const def = MODULE_KEYS[mod.moduleKey];
      return {
        ...mod,
        id: mod._id.toString(),
        route: def?.route || null,
        description: def?.description || null,
        section: def?.section || null,
        alwaysOn: def?.alwaysOn || false,
      };
    });

    return reply.send(successResponse(enriched, "Modules retrieved"));
  } catch (err: any) {
    console.error("getModules error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── PUT /api/modules/:moduleKey — Toggle a single module ────────
export async function toggleModule(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization context required"));
    }

    const { moduleKey } = req.params as { moduleKey: string };
    const { enabled } = req.body as { enabled: boolean };

    if (typeof enabled !== "boolean") {
      return reply.code(400).send(errorResponse("'enabled' must be a boolean"));
    }

    // Validate module key exists
    if (!MODULE_KEYS[moduleKey]) {
      return reply.code(404).send(errorResponse(`Unknown module key: ${moduleKey}`));
    }

    // Prevent disabling always-on modules
    const alwaysOn = getAlwaysOnModules();
    if (!enabled && alwaysOn.includes(moduleKey)) {
      return reply.code(400).send(errorResponse(`Module '${moduleKey}' cannot be disabled — it is a core system module`));
    }

    const updated = await ModuleRegistry.findOneAndUpdate(
      { organizationId: orgId, moduleKey },
      {
        enabled,
        updatedBy: req.user?.id,
      },
      { new: true, upsert: true }
    ).lean();

    return reply.send(successResponse(updated, `Module '${moduleKey}' ${enabled ? "enabled" : "disabled"}`));
  } catch (err: any) {
    console.error("toggleModule error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── PUT /api/modules/bulk — Bulk toggle multiple modules ────────
export async function bulkToggleModules(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) {
      return reply.code(400).send(errorResponse("Organization context required"));
    }

    const { modules } = req.body as { modules: Array<{ moduleKey: string; enabled: boolean }> };

    if (!Array.isArray(modules) || modules.length === 0) {
      return reply.code(400).send(errorResponse("'modules' must be a non-empty array of { moduleKey, enabled }"));
    }

    const alwaysOn = getAlwaysOnModules();
    const ops = [];
    const errors: string[] = [];

    for (const { moduleKey, enabled } of modules) {
      if (!MODULE_KEYS[moduleKey]) {
        errors.push(`Unknown module key: ${moduleKey}`);
        continue;
      }
      if (!enabled && alwaysOn.includes(moduleKey)) {
        errors.push(`Cannot disable always-on module: ${moduleKey}`);
        continue;
      }

      ops.push({
        updateOne: {
          filter: { organizationId: orgId, moduleKey },
          update: {
            $set: {
              enabled,
              updatedBy: req.user?.id,
              priority: MODULE_KEYS[moduleKey].priority,
              label: MODULE_KEYS[moduleKey].label,
            },
          },
          upsert: true,
        },
      });
    }

    if (ops.length > 0) {
      await ModuleRegistry.bulkWrite(ops);
    }

    const updated = await ModuleRegistry.find({ organizationId: orgId })
      .sort({ priority: 1, label: 1 })
      .lean();

    return reply.send(
      successResponse(
        { modules: updated, errors },
        `${ops.length} module(s) updated${errors.length ? `, ${errors.length} skipped` : ""}`
      )
    );
  } catch (err: any) {
    console.error("bulkToggleModules error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── POST /api/modules/seed — Seed default modules for an org ────
export async function seedModulesEndpoint(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { organizationId } = req.body as { organizationId?: string };
    const orgId = organizationId || req.user?.organization_id;

    if (!orgId) {
      return reply.code(400).send(errorResponse("organizationId is required"));
    }

    const result = await seedModulesForOrg(orgId, req.user?.id);

    return reply.send(successResponse(result, "Modules seeded successfully"));
  } catch (err: any) {
    console.error("seedModules error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}

// ─── Shared Seeding Logic (used by controller + onboarding hook) ─
export async function seedModulesForOrg(organizationId: string, updatedBy?: string, session?: any) {
  const existing = await ModuleRegistry.find({ organizationId }).select("moduleKey").lean();
  const existingKeys = new Set(existing.map((m: any) => m.moduleKey));

  const toInsert = Object.entries(MODULE_KEYS)
    .filter(([key]) => !existingKeys.has(key))
    .map(([key, def]) => ({
      organizationId,
      moduleKey: key,
      enabled: def.priority === "P1", // P1 enabled by default, P2/P3 disabled
      priority: def.priority,
      label: def.label,
      updatedBy: updatedBy || null,
    }));

  if (toInsert.length === 0) {
    return { inserted: 0, message: "All modules already exist" };
  }

  if (session) {
    await ModuleRegistry.insertMany(toInsert, { session });
  } else {
    await ModuleRegistry.insertMany(toInsert);
  }

  return { inserted: toInsert.length, message: `${toInsert.length} modules seeded` };
}

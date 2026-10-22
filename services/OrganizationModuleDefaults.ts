import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { Organization } from "../models/Organization.ts";
import { MODULE_KEYS, getAlwaysOnModules } from "../data/moduleKeys.ts";

export async function seedModulesForOrg(organizationId: string, updatedBy?: string, session?: any, profile?: "clinic" | "pharmacy") {
  const pharmacyModules = new Set([...getAlwaysOnModules(), "pharmacy", "billing", "staff", "locations", "settings", "notifications", "audit"]);
  const existing = await ModuleRegistry.find({ organizationId }).select("moduleKey").lean();
  const existingKeys = new Set(existing.map((m: any) => m.moduleKey));
  if (Object.keys(MODULE_KEYS).every(key => existingKeys.has(key))) return { inserted: 0, message: "All modules already exist" };
  const selectedProfile = profile || (await Organization.findById(organizationId).select("workspaceProfile").lean())?.workspaceProfile || "clinic";

  const toInsert = Object.entries(MODULE_KEYS)
    .filter(([key]) => !existingKeys.has(key))
    .map(([key, def]) => ({
      organizationId,
      moduleKey: key,
      enabled: selectedProfile === "pharmacy" ? pharmacyModules.has(key) : def.priority === "P1",
      priority: def.priority,
      label: def.label,
      updatedBy: updatedBy || null,
    }));

  if (toInsert.length === 0) {
    return { inserted: 0, message: "All modules already exist" };
  }

  try {
    if (session) {
      await ModuleRegistry.insertMany(toInsert, { session, ordered: false });
    } else {
      await ModuleRegistry.insertMany(toInsert, { ordered: false });
    }
  } catch (err: any) {
    // Gracefully ignore duplicate key collisions (E11000) from concurrent requests
    if (!err.message?.includes("E11000") && err.code !== 11000) {
      throw err;
    }
  }

  return { inserted: toInsert.length, message: `${toInsert.length} modules seeded` };
}

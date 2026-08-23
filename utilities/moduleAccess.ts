import { ModuleRegistry } from "../models/ModuleRegistry.ts";
import { MODULE_KEYS, getAlwaysOnModules } from "../data/moduleKeys.ts";

/**
 * Returns whether a module is enabled for an organization (same rules as requireModule middleware).
 */
export async function isModuleEnabledForOrganization(
  organizationId: string | undefined | null,
  moduleKey: string
): Promise<boolean> {
  if (!organizationId) return false;

  if (getAlwaysOnModules().includes(moduleKey)) return true;

  if (!MODULE_KEYS[moduleKey]) return true;

  const record = await ModuleRegistry.findOne({ organizationId, moduleKey }).lean();
  if (record) return !!(record as { enabled?: boolean }).enabled;

  return MODULE_KEYS[moduleKey].priority === "P1";
}

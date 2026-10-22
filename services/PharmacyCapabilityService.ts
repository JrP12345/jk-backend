import type { FastifyRequest } from "fastify";
import { Location } from "../models/Location.ts";
import { Organization } from "../models/Organization.ts";
import { getEffectivePermissions } from "../utilities/permissions.ts";
import { isModuleEnabledForOrganization } from "../utilities/moduleAccess.ts";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { PHARMACY_ACTION_GRANTS, PHARMACY_NEW_ACTIVITY, pharmacyAllows, type PharmacyAction } from "../utilities/pharmacyPermissions.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { getOrganizationProductEntitlements } from "./billing/ProductEntitlementService.ts";

export async function pharmacyRequestAllows(req: FastifyRequest, action: PharmacyAction) {
  if (!req.user || ["patient", "family_member", "guest"].includes(req.user.role)) return false;
  const permissions = await getEffectivePermissions(req.user.role, req.user.organization_id, req.user.authVersion, true);
  return pharmacyAllows(permissions, action, req.user.role === "root");
}
export async function pharmacyCapabilities(req: FastifyRequest, locationId: string) {
  const access = await checkLocationAccess(req, locationId);
  if (!access.allowed) throw new CommandError(access.statusCode, access.message);
  const location = await Location.findOne({ _id: locationId, organizationId: access.organizationId }).select("pharmacyCapability").lean();
  if (!location || !req.user || ["patient", "family_member", "guest"].includes(req.user.role)) throw new CommandError(403, "Pharmacy staff authority is required");
  const permissions = await getEffectivePermissions(req.user.role, req.user.organization_id, req.user.authVersion, true);
  const root = req.user.role === "root";
  const moduleEnabled = await isModuleEnabledForOrganization(access.organizationId, "pharmacy");
  const enabled = location.pharmacyCapability?.enabled !== false;
  if (!access.organizationId) throw new CommandError(404, "Organization not found");
  const entitlement = await getOrganizationProductEntitlements(access.organizationId);
  const businessEnabled = !entitlement.enforcement || entitlement.active && entitlement.pharmacyLocationIds.includes(locationId);
  const actions = Object.fromEntries((Object.keys(PHARMACY_ACTION_GRANTS) as PharmacyAction[]).map(action => [action,
    (action === "manageSettings" || root || moduleEnabled) && pharmacyAllows(permissions, action, root) && (!PHARMACY_NEW_ACTIVITY.has(action) || enabled && (businessEnabled || action === "adjustStock" || action === "collect")),
  ])) as Record<PharmacyAction, boolean>;
  const organization = await Organization.findById(access.organizationId).select("workspaceProfile").lean();
  if (organization?.workspaceProfile === "pharmacy") { actions.viewRxQueue = false; actions.dispense = false; actions.recoverDispense = false; }
  const importKinds = (root || moduleEnabled ? [
    ["catalogue", ["manageCatalog", "viewStock"]], ["opening_stock", ["receiveStock", "viewStock", "viewCost"]],
    ["customer_dues", ["openingBalances", "viewReturns"]], ["supplier_dues", ["openingBalances", "viewPurchases"]],
  ] as Array<[string, PharmacyAction[]]> : []).filter(([, required]) => required.every(action => pharmacyAllows(permissions, action, root))).map(([kind]) => kind);
  return { locationId, organizationId: access.organizationId, enabled, moduleEnabled, rootOverride: root,
    mode: location.pharmacyCapability ? "configured" : "legacy_included", revision: location.pharmacyCapability?.revision || 0,
    actions, importKinds, commercialEntitlement: entitlement.enforcement ? businessEnabled ? "active" : "unavailable" : "plan_included", counterSalesAvailable: actions.sell, restrictedQualificationRequired: true };
}

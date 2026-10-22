import type { FastifyReply, FastifyRequest } from "fastify";
import { denyRoles } from "./auth.ts";
import { errorResponse } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope, checkLocationAccess } from "../utilities/tenant.ts";
import { Medicine } from "../models/Medicine.ts";
import { Location } from "../models/Location.ts";
import { pharmacyRequestAllows } from "../services/PharmacyCapabilityService.ts";
import { PHARMACY_NEW_ACTIVITY, type PharmacyAction } from "../utilities/pharmacyPermissions.ts";
import { getOrganizationProductEntitlements } from "../services/billing/ProductEntitlementService.ts";

const denyConsumers = denyRoles("patient", "family_member", "guest");

/** Operational pharmacy grants must never inherit consumer EHR/location access. */
export async function requirePharmacyStaff(req: FastifyRequest, reply: FastifyReply) {
  await denyConsumers(req, reply);
  if (reply.sent) return;

  const scope = resolveAuthorizedOrganizationScope(req);
  if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
}

export function requirePharmacyAction(action: PharmacyAction) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!await pharmacyRequestAllows(req, action)) return reply.code(403).send(errorResponse("Pharmacy action permission is required"));
    if (!PHARMACY_NEW_ACTIVITY.has(action) || action === "dispense" || action === "adjustStock") return;
    const params = req.params as { id?: string };
    const body = req.body as { locationId?: string; medicineId?: string } | undefined;
    const query = req.query as { locationId?: string };
    let locationId = body?.locationId || query.locationId;
    if (!locationId && (params.id || body?.medicineId)) {
      const id = params.id || body?.medicineId;
      if (!id || !/^[a-f0-9]{24}$/i.test(id)) return;
      locationId = String((await Medicine.findById(id).select("locationId").lean())?.locationId || "");
    }
    if (!locationId) return;
    const access = await checkLocationAccess(req, locationId);
    if (!access.allowed) return reply.code(access.statusCode).send(errorResponse(access.message));
    const location = await Location.findById(locationId).select("pharmacyCapability").lean();
    if (location?.pharmacyCapability?.enabled === false) return reply.code(409).send(errorResponse("Pharmacy is disabled at this location"));
    // Mutation checks belong inside recorded transactions, after replay lookup.
    if (action === "viewRxQueue") {
      if (!access.organizationId) return reply.code(404).send(errorResponse("Organization not found"));
      const entitlement = await getOrganizationProductEntitlements(access.organizationId);
      if (entitlement.enforcement && (!entitlement.active || !entitlement.pharmacyLocationIds.includes(locationId))) return reply.code(402).send(errorResponse("An active pharmacy product is required for new dispensing work"));
    }
  };
}

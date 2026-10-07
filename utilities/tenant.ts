import mongoose from "mongoose";
import { Location } from "../models/Location.ts";
import { Patient } from "../models/Patient.ts";
import type { FastifyRequest } from "fastify";

/**
 * Resolve the organization carried by the authenticated JWT.
 *
 * All callers must use `organization_id`, which is the field populated by
 * authentication.  The older `organizationId` spelling is deliberately not
 * accepted here; silently accepting it was the source of random-tenant
 * records in several operational controllers.
 */
export function getRequestOrganizationId(req: FastifyRequest): string | undefined {
  const organizationId = req.user?.organization_id;
  return organizationId && mongoose.Types.ObjectId.isValid(organizationId)
    ? organizationId
    : undefined;
}

export function isRootRequest(req: FastifyRequest): boolean {
  return req.user?.role === "root";
}

/**
 * Resolves the target organization ID for an operation.
 * 1. If req.user.organization_id is present, returns it.
 * 2. If caller is Root Super-Admin, it may explicitly choose an organization
 *    through a validated query/body value or a location in the query/body.
 *
 * HTTP tenant headers are deliberately never used as authority. They are
 * browser-controlled and must not decide which tenant a request operates on.
 */
export async function resolveTargetOrganizationId(req: FastifyRequest): Promise<string | undefined> {
  const scope = resolveAuthorizedOrganizationScope(req);
  if (scope.allowed && scope.organizationId) return scope.organizationId;

  if (isRootRequest(req)) {
    const locationId =
      (req.query as { locationId?: string; location_id?: string })?.locationId ||
      (req.query as { locationId?: string; location_id?: string })?.location_id ||
      (req.body as { locationId?: string; location_id?: string })?.locationId ||
      (req.body as { locationId?: string; location_id?: string })?.location_id;

    if (locationId && mongoose.Types.ObjectId.isValid(locationId)) {
      const location = await Location.findById(locationId).select("organizationId").lean();
      if (location?.organizationId) return location.organizationId.toString();
    }
  }

  return undefined;
}

export type TenantCheck =
  | { allowed: true; organizationId: string | undefined }
  | { allowed: false; statusCode: 400 | 403 | 404; message: string };

/**
 * Resolve the one organization a request may operate on. Non-root callers are
 * always scoped to their authenticated membership; a body/query organization
 * is only a consistency assertion and a mismatch is rejected. Root workflows
 * may explicitly select a valid organization. Request headers are ignored.
 */
export function resolveAuthorizedOrganizationScope(req: FastifyRequest): TenantCheck {
  const requestedOrganizationId =
    (req.body as { organizationId?: unknown; organization_id?: unknown } | undefined)?.organizationId ||
    (req.body as { organizationId?: unknown; organization_id?: unknown } | undefined)?.organization_id ||
    (req.query as { organizationId?: unknown; organization_id?: unknown } | undefined)?.organizationId ||
    (req.query as { organizationId?: unknown; organization_id?: unknown } | undefined)?.organization_id;
  const requested = typeof requestedOrganizationId === "string" ? requestedOrganizationId : undefined;

  if (requested && !mongoose.Types.ObjectId.isValid(requested)) {
    return { allowed: false, statusCode: 400, message: "Invalid organization ID" };
  }

  const authenticatedOrganizationId = getRequestOrganizationId(req);
  if (isRootRequest(req)) {
    return { allowed: true, organizationId: requested || authenticatedOrganizationId };
  }
  if (!authenticatedOrganizationId) {
    return { allowed: false, statusCode: 403, message: "Organization context is required" };
  }
  if (requested && requested !== authenticatedOrganizationId) {
    return { allowed: false, statusCode: 403, message: "Cross-tenant organization selection is not allowed" };
  }
  return { allowed: true, organizationId: authenticatedOrganizationId };
}

/**
 * Verify that a location belongs to the caller's active organization.
 * Root retains the existing system-wide behavior, but the ID must still be
 * syntactically valid so malformed references do not reach Mongoose.
 */
export async function checkLocationAccess(
  req: FastifyRequest,
  locationId: unknown,
): Promise<TenantCheck> {
  const normalizedLocationId =
    typeof locationId === "string"
      ? locationId
      : locationId instanceof mongoose.Types.ObjectId
        ? locationId.toString()
        : typeof locationId === "object" && locationId !== null && "_id" in locationId
          ? String((locationId as { _id: unknown })._id)
          : "";

  if (!mongoose.Types.ObjectId.isValid(normalizedLocationId)) {
    return { allowed: false, statusCode: 400, message: "Invalid location ID" };
  }

  const organizationId = getRequestOrganizationId(req);
  const location = await Location.findOne({
    _id: normalizedLocationId,
    isActive: { $ne: false },
  }).select("organizationId").lean();

  if (!location) {
    return { allowed: false, statusCode: 404, message: "Location not found" };
  }

  if (isRootRequest(req)) {
    return { allowed: true, organizationId: location.organizationId.toString() };
  }

  // Patients & family members are consumers and can view or book across any location
  if (req.user?.role === "patient" || req.user?.role === "family_member" || req.user?.role === "guest") {
    return { allowed: true, organizationId: location.organizationId.toString() };
  }

  if (!organizationId) {
    return { allowed: false, statusCode: 403, message: "Organization context is required" };
  }

  if (location.organizationId.toString() !== organizationId) {
    return { allowed: false, statusCode: 404, message: "Location not found" };
  }

  return { allowed: true, organizationId };
}

/** Return only locations visible to the authenticated organization. */
export async function getRequestLocationIds(req: FastifyRequest) {
  if (isRootRequest(req)) return undefined;

  const organizationId = getRequestOrganizationId(req);
  if (!organizationId) return [];

  const locations = await Location.find({ organizationId, isActive: { $ne: false } })
    .select("_id")
    .lean();
  return locations.map((location) => location._id);
}

/** Verify a patient belongs to the caller's organization. */
export async function checkPatientAccess(
  req: FastifyRequest,
  patientId: unknown,
): Promise<TenantCheck> {
  if (typeof patientId !== "string" || !mongoose.Types.ObjectId.isValid(patientId)) {
    return { allowed: false, statusCode: 400, message: "Invalid patient ID" };
  }

  if (isRootRequest(req)) {
    return { allowed: true, organizationId: getRequestOrganizationId(req) };
  }

  // Patients and family members can access their own or dependent records
  if (req.user?.role === "patient" || req.user?.role === "family_member") {
    const patient = await Patient.findById(patientId).select("userId organizationId").lean();
    if (patient) {
      if (patient.userId?.toString() === req.user.id) {
        return { allowed: true, organizationId: patient.organizationId?.toString() };
      }
      const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
      const isFamily = await FamilyRelationship.exists({
        userId: req.user.id,
        patientId,
        status: "active",
      });
      if (isFamily) {
        return { allowed: true, organizationId: patient.organizationId?.toString() };
      }
    }
    // Organization membership does not grant consumers access to other
    // patients. Only staff may continue to the organization-level check.
    return { allowed: false, statusCode: 404, message: "Patient not found" };
  }

  const organizationId = getRequestOrganizationId(req);
  if (!organizationId) {
    return { allowed: false, statusCode: 403, message: "Organization context is required" };
  }

  const patient = await Patient.exists({ _id: patientId, organizationId });
  if (!patient) {
    return { allowed: false, statusCode: 404, message: "Patient not found" };
  }

  return { allowed: true, organizationId };
}

/** Verify both the record's location and its explicit organization field. */
export async function checkOperationalRecordAccess(
  req: FastifyRequest,
  record: { locationId?: unknown; organizationId?: unknown },
): Promise<TenantCheck> {
  const locationCheck = await checkLocationAccess(req, record.locationId);
  if (!locationCheck.allowed) return locationCheck;

  if (!isRootRequest(req) && record.organizationId && locationCheck.organizationId) {
    if (String(record.organizationId) !== locationCheck.organizationId) {
      return { allowed: false, statusCode: 404, message: "Record not found" };
    }
  }

  return locationCheck;
}

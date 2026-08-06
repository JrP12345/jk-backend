import mongoose from "mongoose";
import { Clinic } from "../models/Clinic.ts";
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

export type TenantCheck =
  | { allowed: true; organizationId: string | undefined }
  | { allowed: false; statusCode: 400 | 403 | 404; message: string };

/**
 * Verify that a clinic belongs to the caller's active organization.
 * Root retains the existing system-wide behavior, but the ID must still be
 * syntactically valid so malformed references do not reach Mongoose.
 */
export async function checkClinicAccess(
  req: FastifyRequest,
  clinicId: unknown,
): Promise<TenantCheck> {
  const normalizedClinicId =
    typeof clinicId === "string"
      ? clinicId
      : clinicId instanceof mongoose.Types.ObjectId
        ? clinicId.toString()
        : typeof clinicId === "object" && clinicId !== null && "_id" in clinicId
          ? String((clinicId as { _id: unknown })._id)
          : "";

  if (!mongoose.Types.ObjectId.isValid(normalizedClinicId)) {
    return { allowed: false, statusCode: 400, message: "Invalid clinic ID" };
  }

  const organizationId = getRequestOrganizationId(req);
  const clinic = await Clinic.findOne({
    _id: normalizedClinicId,
    isActive: { $ne: false },
  }).select("organizationId").lean();

  if (!clinic) {
    return { allowed: false, statusCode: 404, message: "Clinic not found" };
  }

  if (isRootRequest(req)) {
    return { allowed: true, organizationId: clinic.organizationId.toString() };
  }

  // Patient self-booking is the existing public booking flow.  A newly
  // registered patient may not have an organization in the JWT yet; resolve
  // the selected clinic's organization and bind the patient during booking.
  if (!organizationId && req.user?.role === "patient") {
    return { allowed: true, organizationId: clinic.organizationId.toString() };
  }

  if (!organizationId) {
    return { allowed: false, statusCode: 403, message: "Organization context is required" };
  }

  if (clinic.organizationId.toString() !== organizationId) {
    return { allowed: false, statusCode: 404, message: "Clinic not found" };
  }

  return { allowed: true, organizationId };
}

/** Return only clinics visible to the authenticated organization. */
export async function getRequestClinicIds(req: FastifyRequest) {
  if (isRootRequest(req)) return undefined;

  const organizationId = getRequestOrganizationId(req);
  if (!organizationId) return [];

  const clinics = await Clinic.find({ organizationId, isActive: { $ne: false } })
    .select("_id")
    .lean();
  return clinics.map((clinic) => clinic._id);
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

/** Verify both the record's clinic and its explicit organization field. */
export async function checkOperationalRecordAccess(
  req: FastifyRequest,
  record: { clinicId?: unknown; organizationId?: unknown },
): Promise<TenantCheck> {
  const clinicCheck = await checkClinicAccess(req, record.clinicId);
  if (!clinicCheck.allowed) return clinicCheck;

  if (!isRootRequest(req) && record.organizationId && clinicCheck.organizationId) {
    if (String(record.organizationId) !== clinicCheck.organizationId) {
      return { allowed: false, statusCode: 404, message: "Record not found" };
    }
  }

  return clinicCheck;
}

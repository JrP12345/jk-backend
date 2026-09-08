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

/**
 * Resolves the target organization ID for an operation.
 * 1. If req.user.organization_id is present, returns it.
 * 2. If caller is Root Super-Admin:
 *    a. Checks query ?organizationId=...
 *    b. Checks header x-organization-id
 *    c. Checks body { organizationId: ... }
 *    d. Checks x-clinic-id header or clinicId in query/body (looks up clinic.organizationId)
 *    e. Fallback: finds first organization in MongoDB
 */
export async function resolveTargetOrganizationId(req: FastifyRequest): Promise<string | undefined> {
  const jwtOrgId = getRequestOrganizationId(req);
  if (jwtOrgId) return jwtOrgId;

  if (isRootRequest(req)) {
    const fromQuery = (req.query as { organizationId?: string })?.organizationId;
    if (fromQuery && mongoose.Types.ObjectId.isValid(fromQuery)) return fromQuery;

    const fromHeader = req.headers["x-organization-id"] as string;
    if (fromHeader && mongoose.Types.ObjectId.isValid(fromHeader)) return fromHeader;

    const fromBody = (req.body as { organizationId?: string })?.organizationId;
    if (fromBody && mongoose.Types.ObjectId.isValid(fromBody)) return fromBody;

    const clinicId =
      (req.headers["x-clinic-id"] as string) ||
      (req.query as { clinicId?: string })?.clinicId ||
      (req.body as { clinicId?: string })?.clinicId;

    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) {
      const clinic = await Clinic.findById(clinicId).select("organizationId").lean();
      if (clinic?.organizationId) return clinic.organizationId.toString();
    }
  }

  return undefined;
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

  // Patients & family members are consumers and can view or book across any clinic
  if (req.user?.role === "patient" || req.user?.role === "family_member") {
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

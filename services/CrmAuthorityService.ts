import type { FastifyRequest } from "fastify";
import { getRequestLocationIds, resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { getOrganizationPatient } from "./PatientRecordAccessService.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { Appointment } from "../models/Appointment.ts";
import { CommandError } from "./CommandReceiptService.ts";
import { resolveStaffLocationGrant } from "./LocationAccessService.ts";

export async function crmAuthority(req: FastifyRequest) {
  if (!req.user || ["patient", "family_member", "guest"].includes(req.user.role)) throw new CommandError(403, "Staff workspace required");
  const scope = resolveAuthorizedOrganizationScope(req);
  if (!scope.allowed) throw new CommandError(scope.statusCode, scope.message);
  if (!scope.organizationId) throw new CommandError(403, "Select an organization workspace");
  const grant = req.user.role === "root" ? undefined : await resolveStaffLocationGrant(req.user.id, scope.organizationId, req.user.role, true);
  if (grant?.length === 0) throw new CommandError(403, "No reviewed branch access is available");
  const locationIds = await getRequestLocationIds(req, { requireExplicitScope: true });
  return { organizationId: scope.organizationId, actorId: req.user.id, locationIds, allLocations: grant === undefined };
}
export async function crmPatientAuthority(req: FastifyRequest, patientId: string) {
  const authority = await crmAuthority(req);
  const patient = await getOrganizationPatient(patientId, authority.organizationId);
  if (!patient) throw new CommandError(404, "Patient not found in this workspace");
  if (!authority.allLocations) {
    const relationship = await PatientRelationship.exists({ organizationId: authority.organizationId, patientId,
      status: "active", locationId: { $in: authority.locationIds } });
    const visit = relationship || await Appointment.exists({ organizationId: authority.organizationId, patientId,
      locationId: { $in: authority.locationIds } });
    if (!visit) throw new CommandError(404, "Patient not found in your branches");
  }
  return { ...authority, patient };
}

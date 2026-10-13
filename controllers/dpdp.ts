import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { Patient } from "../models/Patient.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { authorizedFamilyRelationship } from "../services/FamilyAuthorityService.ts";
import { DataBreachIncident } from "../models/DataBreachIncident.ts";
import { Organization } from "../models/Organization.ts";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { Appointment } from "../models/Appointment.ts";
import { DPDPService } from "../services/DPDPService.ts";
import { getPrivacyRequest, reviewPrivacyRequest } from "../services/PatientPrivacyService.ts";
import { crmPatientAuthority, crmAuthority } from "../services/CrmAuthorityService.ts";
import { getOrganizationPatient } from "../services/PatientRecordAccessService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { requestHasAnyPermission } from "../utilities/permissions.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { runWithContext, requestContextStore } from "../utilities/context.ts";

async function privacyAuthority(req: FastifyRequest, purpose: "consent" | "export" | "privacy", write = false) {
  if (!req.user || req.user.role === "guest") throw new CommandError(403, "Authenticated patient or authorized staff required");
  if (write && req.user.impersonatedBy) throw new CommandError(403, "End impersonation before changing privacy choices");
  const input = { ...(req.query as any), ...(req.body as any) };
  if (["patient", "family_member"].includes(req.user.role)) {
    const self = await Patient.findOne({ userId: req.user.id }).setOptions({ bypassTenantFilter: true }).select("organizationId");
    const patientId = input.patientId || self?.id;
    if (!patientId || !mongoose.Types.ObjectId.isValid(patientId)) throw new CommandError(400, "Select a patient profile");
    const organizationId = input.organizationId || self?.organizationId?.toString();
    if (!organizationId || !mongoose.Types.ObjectId.isValid(organizationId)) throw new CommandError(400, "Select an associated organization");
    let familyRelationshipId: string | undefined;
    if (self?.id !== patientId) {
      const delegation = await authorizedFamilyRelationship(patientId, organizationId, purpose === "consent" ? "consent" : "dataRights", { userId: req.user.id });
      if (!delegation) throw new CommandError(403, "A booking relationship does not authorize consent or privacy actions");
      familyRelationshipId = String(delegation._id);
    }
    if (!await getOrganizationPatient(patientId, organizationId)) throw new CommandError(404, "Patient not found in this organization");
    return { patientId, organizationId, actorId: req.user.id, consumer: true, familyRelationshipId, locationIds: undefined, allLocations: true };
  }
  const permission = purpose === "consent" ? "RECORD_COMMUNICATION_CONSENT" : purpose === "export" ? "EXPORT_CRM" : "ADMINISTRATIVE_GOVERNANCE";
  if (!await requestHasAnyPermission(req, permission)) throw new CommandError(403, "This action requires an explicit workspace permission");
  if (!input.patientId || !mongoose.Types.ObjectId.isValid(input.patientId)) throw new CommandError(400, "Select a valid patient record");
  const authority = await crmPatientAuthority(req, input.patientId);
  return { ...authority, patientId: input.patientId, consumer: false, familyRelationshipId: undefined };
}
function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, "Privacy workflow failed");
  return reply.code(503).send(errorResponse("The result could not be confirmed. Retry the same request."));
}
function scopedPrivacy<T>(authority: { organizationId: string }, work: () => Promise<T>) {
  return runWithContext({ ...requestContextStore.getStore(), organizationId: authority.organizationId }, work);
}
export async function listPrivacyOrganizations(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (!req.user || !["patient", "family_member"].includes(req.user.role)) throw new CommandError(403, "Patient account required");
    const query = req.query as { patientId?: string; cursor?: string };
    const self = await Patient.findOne({ userId: req.user.id }).setOptions({ bypassTenantFilter: true }).select("organizationId");
    const patientId = query.patientId || self?.id;
    if (!patientId || !mongoose.Types.ObjectId.isValid(patientId) || (query.cursor && !mongoose.Types.ObjectId.isValid(query.cursor))) throw new CommandError(400, "Valid patient and cursor references are required");
    const family = patientId !== self?.id ? await FamilyRelationship.findOne({ userId: req.user.id, patientId, status: "active" }).lean() : null;
    const delegatedIds = family?.organizationAuthorizations?.filter((row: any) => (row.consent || row.dataRights) && row.reviewedBy && row.reviewedAt).map((row: any) => String(row.organizationId)) || [];
    if (patientId !== self?.id && !delegatedIds.length) throw new CommandError(403, "Separate organization privacy delegation required");
    const patient = await Patient.findById(patientId).setOptions({ bypassTenantFilter: true }).select("organizationId");
    const filter = { patientId: new mongoose.Types.ObjectId(patientId), organizationId: { ...(query.cursor ? { $gt: new mongoose.Types.ObjectId(query.cursor) } : { $type: "objectId" }), ...(patientId === self?.id ? {} : { $in: delegatedIds.map((id: string) => new mongoose.Types.ObjectId(id)) }) } };
    const sources = await Promise.all([
      Appointment.aggregate([{ $match: filter }, { $group: { _id: "$organizationId" } }, { $sort: { _id: 1 } }, { $limit: 21 }]).option({ maxTimeMS: 5000 }),
      PatientRelationship.find({ ...filter, status: "active" }).setOptions({ bypassTenantFilter: true }).select("organizationId").sort({ organizationId: 1 }).limit(21).lean(),
    ]);
    const ids = [...new Set([...sources[0].map(row => String(row._id)), ...sources[1].map(row => String(row.organizationId)),
      ...(patient?.organizationId && (!query.cursor || String(patient.organizationId) > query.cursor) ? [String(patient.organizationId)] : [])])].filter(id => patientId === self?.id || delegatedIds.includes(id)).sort();
    const organizations = await Organization.find({ _id: { $in: ids.slice(0, 20) } }).select("name").sort({ _id: 1 }).lean();
    reply.header("Cache-Control", "no-store");
    return reply.send(successResponse({ items: organizations.map(row => {
      const grant = family?.organizationAuthorizations?.find((grant: any) => String(grant.organizationId) === String(row._id));
      return { id: String(row._id), name: row.name, ...(family ? { consentAuthority: grant?.consent === true, dataRightsAuthority: grant?.dataRights === true } : {}) };
    }), nextCursor: ids.length > 20 ? ids[19] : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function exportPatientData(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await privacyAuthority(req, "export");
    const query = req.query as Record<string, string>;
    const cursors = Object.fromEntries(["appointments", "invoices", "encounters", "prescriptions", "labOrders"].filter(name => query[`${name}Cursor`]).map(name => [name, query[`${name}Cursor`]]));
    const includeClinical = authority.consumer || await requestHasAnyPermission(req, "VIEW_EHR");
    const result = await scopedPrivacy(authority, () => DPDPService.exportPatientData(authority.patientId, authority.organizationId, { actorId: authority.actorId,
      locationIds: authority.consumer ? undefined : authority.locationIds, includeClinical, cursors, resources: query.resources?.split(",") }));
    await privacyAuthority(req, "export");
    reply.header("Cache-Control", "no-store");
    return reply.send(successResponse(result, result.metadata.truncated ? "Export page ready. Continue using the returned cursors." : "Organization export ready"));
  } catch (error) { return failure(req, reply, error); }
}
export async function requestPatientErasure(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await privacyAuthority(req, "privacy", true);
    const result = await scopedPrivacy(authority, () => DPDPService.executePatientErasure(authority.patientId, authority.actorId, authority.organizationId, req.body as any, authority.familyRelationshipId));
    return reply.code(202).send(successResponse(result, "Privacy request recorded for organization review"));
  } catch (error) { return failure(req, reply, error); }
}
export async function getPatientPrivacyRequest(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await privacyAuthority(req, "privacy");
    return reply.send(successResponse(await scopedPrivacy(authority, () => getPrivacyRequest(authority.patientId, authority.organizationId))));
  } catch (error) { return failure(req, reply, error); }
}
export async function reviewPatientPrivacyRequest(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await privacyAuthority(req, "privacy", true);
    if (authority.consumer) throw new CommandError(403, "An authorized organization reviewer must review the request");
    if (!authority.allLocations) throw new CommandError(403, "Organization-wide privacy review requires access to all branches");
    return reply.send(successResponse(await scopedPrivacy(authority, () => reviewPrivacyRequest(authority.patientId, authority.actorId, authority.organizationId, req.body as any)), "Privacy review recorded"));
  } catch (error) { return failure(req, reply, error); }
}
export async function getPatientConsents(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await privacyAuthority(req, "consent");
    reply.header("Cache-Control", "no-store");
    return reply.send(successResponse(await scopedPrivacy(authority, () => DPDPService.getPatientConsents(authority.patientId, authority.organizationId))));
  } catch (error) { return failure(req, reply, error); }
}
export async function updatePatientConsents(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await privacyAuthority(req, "consent", true);
    const input = req.body as any;
    if (authority.consumer && input.method !== "portal_confirmation") throw new CommandError(400, "Use portal confirmation for patient choices");
    if (!authority.consumer && input.method === "portal_confirmation") throw new CommandError(400, "Staff must record the actual patient evidence method");
    return reply.send(successResponse(await scopedPrivacy(authority, () => DPDPService.updatePatientConsents(authority.patientId, authority.organizationId, input.updates,
      { actorId: authority.actorId, familyRelationshipId: authority.familyRelationshipId, clientRequestId: input.clientRequestId,
        expectedRevision: input.expectedRevision, method: input.method, acknowledged: input.acknowledged, noticeVersion: input.noticeVersion, note: input.note })), "Consent choices recorded"));
  } catch (error) { return failure(req, reply, error); }
}
export async function recordBreachIncident(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.organizationId;
    if (!orgId && req.user?.role !== "root") {
      return reply.code(403).send(errorResponse("Organization context required"));
    }

    const body = req.body as any;
    if (!body.title || !body.description || !body.severity || !body.dataCategoriesExposed) {
      return reply.code(400).send(errorResponse("Missing required breach incident fields"));
    }

    const incident = await DPDPService.recordBreachIncident(
      {
        ...body,
        organizationId: orgId || body.organizationId,
      },
      req.user!.id
    );

    return reply.code(201).send(successResponse(incident, "Breach incident logged successfully"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to log breach incident"));
  }
}

export async function getBreachIncidents(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && req.user?.role !== "root") return reply.code(scope.statusCode).send(errorResponse(scope.message));
    const orgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    const filter: any = {};
    if (orgId && req.user?.role !== "root") {
      filter.organizationId = orgId;
    }

    if (!orgId) return reply.code(403).send(errorResponse("Select an organization workspace"));
    filter.organizationId = orgId;
    const incidents = await DataBreachIncident.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    return reply.code(200).send(successResponse(incidents));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function generateIncidentDPBIReport(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { incidentId } = req.params as { incidentId: string };
    const authority = await crmAuthority(req);
    const report = await DPDPService.generateDPBIReport(incidentId, authority.organizationId);
    return reply.code(200).send(successResponse(report, "DPBI statutory dossier generated"));
  } catch (err: any) {
    return reply.code(400).send(errorResponse(err.message || "Failed to generate DPBI report"));
  }
}

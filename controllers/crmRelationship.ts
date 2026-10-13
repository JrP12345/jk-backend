import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PatientRelationship } from "../models/PatientRelationship.ts";
import { CrmActivity } from "../models/CrmActivity.ts";
import { Inquiry } from "../models/Inquiry.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Location } from "../models/Location.ts";
import { crmPatientAuthority } from "../services/CrmAuthorityService.ts";
import { validateCrmAssignee } from "../services/CrmAssignmentService.ts";
import { patientAdministrativeDTO } from "../services/PatientAdministrativeDTO.ts";
import { CommandError, executeRecordedCommand } from "../services/CommandReceiptService.ts";
import { checkLocationAccess } from "../utilities/tenant.ts";
import { requestHasAnyPermission } from "../utilities/permissions.ts";
import { pinFamilyAuthority } from '../services/FamilyAuthorityService.ts';
import { successResponse, errorResponse } from "../utilities/helpers.ts";

function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, "Patient relationship workflow failed");
  return reply.code(503).send(errorResponse("The relationship result could not be confirmed. Retry the submitted command or reload before editing."));
}
function id(value: any) { return value?._id?.toString() || value?.toString(); }
export async function getPatientRelationship(req: FastifyRequest, reply: FastifyReply) {
  try {
    const patientId = (req.params as { id: string }).id;
    const authority = await crmPatientAuthority(req, patientId);
    const query = req.query as { activityCursor?: string; inquiryCursor?: string };
    for (const cursor of [query.activityCursor, query.inquiryCursor]) if (cursor && !mongoose.isValidObjectId(cursor)) throw new CommandError(400, "Invalid continuation reference");
    const scoped = { organizationId: authority.organizationId, patientId, ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }) };
    const relationship = await PatientRelationship.findOne({ organizationId: authority.organizationId, patientId }).populate("ownerId", "name").lean() as any;
    // A visit grants access to the patient context, not to another branch's owner,
    // contact override, privacy request or administrative relationship details.
    const visible = relationship && (authority.allLocations || authority.locationIds?.includes(id(relationship.locationId)));
    const [activity, inquiries] = await Promise.all([
      CrmActivity.find({ ...scoped, visibility: "administrative", ...(query.activityCursor ? { _id: { $lt: query.activityCursor } } : {}) }).select("+note kind outcome createdAt actorId inquiryId appointmentId taskId").populate("actorId", "name").sort({ _id: -1 }).limit(21),
      Inquiry.find({ ...scoped, ...(query.inquiryCursor ? { _id: { $lt: query.inquiryCursor } } : {}) }).select("status callerName source locationId createdAt appointmentId").sort({ _id: -1 }).limit(21).lean(),
    ]);
    const canEdit = !!(authority.allLocations || visible || !relationship);
    reply.header("Cache-Control", "no-store");
    return reply.send(successResponse({ patient: patientAdministrativeDTO(authority.patient), relationship: {
      revision: visible ? relationship.revision || 0 : 0, locationId: visible ? id(relationship.locationId) : null,
      ownerId: visible ? id(relationship.ownerId) : null, ownerName: visible ? relationship.ownerId?.name || "" : "",
      preferences: visible ? relationship.preferences || {} : {}, contact: visible ? { availability: relationship.contact?.availability || "unknown", recipientType: relationship.contact?.recipientType || "patient", familyRelationshipId: id(relationship.contact?.familyRelationshipId) } : { availability: "unknown", recipientType: "patient" }, canEdit,
    }, activities: activity.slice(0, 20).map(row => ({ id: row.id, kind: row.kind, outcome: row.outcome, note: row.get("note"), actorName: (row.actorId as any)?.name || "System", createdAt: row.createdAt,
      inquiryId: id(row.inquiryId), appointmentId: id(row.appointmentId), taskId: id(row.taskId) })),
    nextActivityCursor: activity.length > 20 ? activity[19].id : null,
    inquiries: inquiries.slice(0,20).map(row => ({ id: String(row._id), status: row.status, callerName: row.callerName, source: row.source, createdAt: row.createdAt, appointmentId: id(row.appointmentId) })),
    nextInquiryCursor: inquiries.length > 20 ? String(inquiries[19]._id) : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function updatePatientRelationship(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, "End impersonation before changing patient preferences");
    const patientId = (req.params as { id: string }).id, input = req.body as any;
    const authority = await crmPatientAuthority(req, patientId);
    await executeRecordedCommand(`patient-relationship:${authority.organizationId}:${authority.actorId}:${patientId}`, input.clientRequestId, input, async () => {
      const current = await PatientRelationship.findOne({ organizationId: authority.organizationId, patientId });
      if (current?.status === "archived") throw new CommandError(409, "The organization relationship requires review before editing");
      if (current && !authority.allLocations && !authority.locationIds?.includes(id(current.locationId))) throw new CommandError(404, "The organization relationship is outside your branches");
      if ((current?.revision || 0) !== input.expectedRevision) throw new CommandError(409, "Patient relationship changed. Reload before saving.");
      const locationId = input.locationId || id(current?.locationId);
      if (!locationId) throw new CommandError(400, "Choose an authorized branch for this relationship");
      const branch = await checkLocationAccess(req, locationId, { requireExplicitScope: true });
      if (!branch.allowed || branch.organizationId !== authority.organizationId || !await Location.exists({ _id: locationId, organizationId: authority.organizationId, isActive: true })) throw new CommandError(404, "The branch is not available in this workspace");
      const changesOwner = input.ownerId !== undefined && (input.ownerId || "") !== (id(current?.ownerId) || "");
      const transfers = current?.locationId && locationId !== id(current.locationId);
      if ((changesOwner || transfers) && !await requestHasAnyPermission(req, "ASSIGN_CRM_TASKS")) throw new CommandError(403, "Assignment permission is required to change the owner or branch");
      const ownerId = input.ownerId === undefined ? id(current?.ownerId) : input.ownerId;
      if (ownerId) await validateCrmAssignee(ownerId, authority.organizationId, locationId);
      if (input.recipientType === 'family') {
        if (!input.familyRelationshipId) throw new CommandError(400, 'Select the reviewed family recipient');
        await pinFamilyAuthority(patientId, authority.organizationId, 'communication', input.familyRelationshipId);
      }
      if (!current) await PatientRelationship.create({ organizationId: authority.organizationId, patientId, locationId, revision: 0, status: "active" });
      const changed = await PatientRelationship.updateOne({ organizationId: authority.organizationId, patientId, revision: input.expectedRevision }, { $set: { locationId,
        preferences: input.preferences, "contact.availability": input.availability, ...(input.recipientType ? { 'contact.recipientType': input.recipientType, ...(input.recipientType === 'family' ? { 'contact.familyRelationshipId': input.familyRelationshipId } : {}) } : {}), ...(ownerId ? { ownerId } : {}) },
        ...(!ownerId || input.recipientType === 'patient' ? { $unset: { ...(ownerId ? {} : { ownerId: 1 }), ...(input.recipientType === 'patient' ? { 'contact.familyRelationshipId': 1 } : {}) } } : {}), $inc: { revision: 1 } }, { runValidators: true });
      if (changed.modifiedCount !== 1) throw new CommandError(409, "Patient relationship changed. Reload before saving.");
      await CrmActivity.create({ organizationId: authority.organizationId, locationId, patientId, actorId: authority.actorId, kind: transfers ? "relationship_branch_transferred" : changesOwner ? "relationship_reassigned" : "relationship_preferences_updated", outcome: input.availability, revision: input.expectedRevision + 1 });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: "PATIENT_RELATIONSHIP_UPDATED", targetId: patientId, targetModel: "Patient", category: "ADMIN", details: { locationId, ownerId: ownerId || null, revision: input.expectedRevision + 1 } });
      return patientId;
    });
    return getPatientRelationship(req, reply);
  } catch (error) { return failure(req, reply, error); }
}

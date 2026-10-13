import type { FastifyRequest, FastifyReply } from 'fastify';
import { FamilyRelationship } from '../models/FamilyRelationship.ts';
import { User } from '../models/User.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { crmPatientAuthority } from '../services/CrmAuthorityService.ts';
import { familyAuthorization } from '../services/FamilyAuthorityService.ts';
import { executeRecordedCommand, CommandError } from '../services/CommandReceiptService.ts';
import { getEffectivePermissions } from '../utilities/permissions.ts';
import { pinAssignableRole } from '../services/RoleAssignmentService.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';

async function authority(req: FastifyRequest) {
  if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before reviewing family authority');
  const permissions = req.user?.role === 'root' ? null : await getEffectivePermissions(req.user?.role || '', req.user?.organization_id, 1, true);
  if (permissions && (!permissions.has('ADMINISTRATIVE_GOVERNANCE') || !permissions.has('REVIEW_PATIENT_IDENTITY'))) throw new CommandError(403, 'Independent identity review and governance permissions are required');
  const result = await crmPatientAuthority(req, (req.params as { id: string }).id);
  const relationship = await PatientRelationship.findOne({ patientId: result.patient.id, organizationId: result.organizationId }).lean();
  if (!result.allLocations && (!relationship || !result.locationIds?.map(String).includes(String(relationship.locationId)))) throw new CommandError(404, 'Family authority is managed outside your branches');
  if (relationship?.status === 'archived') throw new CommandError(409, 'Review the archived organization relationship first');
  return { ...result, locationId: relationship?.locationId };
}
function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, 'Organization family authority failed');
  return reply.code(503).send(errorResponse('Family authority could not be confirmed. Retry the same submitted review.'));
}
export async function listFamilyAuthorizations(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = await authority(req), cursor = (req.query as { cursor?: string }).cursor;
    const rows = await FamilyRelationship.find({ patientId: scope.patient.id, relationship: { $ne: 'self' }, status: 'active', ...(cursor ? { _id: { $gt: cursor } } : {}) }).sort({ _id: 1 }).limit(21).populate('userId', 'name role isActive').lean();
    reply.header('Cache-Control', 'no-store');
    return reply.send(successResponse({ items: rows.slice(0, 20).map((row: any) => {
      const grant = familyAuthorization(row, scope.organizationId);
      return { id: String(row._id), name: row.userId?.name || 'Family account unavailable', relationship: row.relationship, available: row.userId?.isActive === true && ['patient', 'family_member'].includes(row.userId?.role), revision: row.authorityRevision || 0,
        grants: { communication: grant?.communication === true, consent: grant?.consent === true, dataRights: grant?.dataRights === true }, reviewedAt: grant?.reviewedAt || null };
    }), nextCursor: rows.length > 20 ? String(rows[19]._id) : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function listFamilyRecipients(req: FastifyRequest, reply: FastifyReply) {
  try {
    const scope = await crmPatientAuthority(req, (req.params as { id: string }).id), cursor = (req.query as { cursor?: string }).cursor;
    const relationship = await PatientRelationship.findOne({ patientId: scope.patient.id, organizationId: scope.organizationId }).lean();
    if (!scope.allLocations && (!relationship || !scope.locationIds?.map(String).includes(String(relationship.locationId)))) throw new CommandError(404, 'Family recipients are managed outside your branches');
    const rows = await FamilyRelationship.find({ patientId: scope.patient.id, status: 'active', relationship: { $ne: 'self' }, organizationAuthorizations: { $elemMatch: { organizationId: scope.organizationId, communication: true, reviewedBy: { $type: 'objectId' }, reviewedAt: { $type: 'date' } } }, ...(cursor ? { _id: { $gt: cursor } } : {}) }).sort({ _id: 1 }).limit(21).populate('userId', 'name role isActive').lean();
    reply.header('Cache-Control', 'no-store');
    return reply.send(successResponse({ items: rows.slice(0, 20).filter((row: any) => row.userId?.isActive === true && ['patient', 'family_member'].includes(row.userId.role)).map((row: any) => ({ id: String(row._id), name: row.userId.name, relationship: row.relationship })), nextCursor: rows.length > 20 ? String(rows[19]._id) : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function reviewFamilyAuthorization(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = req.body as any, familyId = (req.params as { familyId: string }).familyId;
    const scope = await authority(req);
    if (!input.identityVerified || !input.reason.trim()) throw new CommandError(400, 'Independently verify the family delegation and record its basis');
    await executeRecordedCommand(`family-authority:${scope.organizationId}:${scope.actorId}:${familyId}`, input.clientRequestId, input, async () => {
      const live = await authority(req);
      await pinAssignableRole(req.user!.role, live.organizationId);
      const family = await FamilyRelationship.findOne({ _id: familyId, patientId: live.patient.id, status: 'active', relationship: { $ne: 'self' } });
      if (!family) throw new CommandError(404, 'Active family relationship not found');
      if (String(family.userId) === live.actorId) throw new CommandError(403, 'A separate reviewer must review your family authority');
      if (!await User.exists({ _id: family.userId, isActive: true, role: { $in: ['patient', 'family_member'] } })) throw new CommandError(409, 'Review the unavailable family account first');
      if ((family.authorityRevision || 0) !== input.expectedRevision) throw new CommandError(409, 'Family authority changed. Reload before reviewing.');
      const previous = familyAuthorization(family, live.organizationId);
      const grant = { organizationId: live.organizationId, ...input.grants, revision: (previous?.revision || 0) + 1, reviewedBy: live.actorId, reviewedAt: new Date() };
      const grants = family.organizationAuthorizations?.filter((row: any) => String(row.organizationId) !== live.organizationId).map((row: any) => row.toObject()) || [];
      const changed = await FamilyRelationship.updateOne({ _id: familyId, status: 'active', $or: [{ authorityRevision: input.expectedRevision }, ...(input.expectedRevision === 0 ? [{ authorityRevision: { $exists: false } }] : [])] }, { $set: { organizationAuthorizations: [...grants, grant] }, $inc: { authorityRevision: 1 } }, { runValidators: true });
      if (changed.modifiedCount !== 1) throw new CommandError(409, 'Family authority changed. Reload before reviewing.');
      await CrmActivity.create({ organizationId: live.organizationId, locationId: live.locationId, patientId: live.patient.id, actorId: live.actorId, kind: 'family_authority_reviewed', visibility: 'privacy', note: input.reason.trim(), revision: grant.revision });
      await AuditLog.create({ organizationId: live.organizationId, userId: live.actorId, action: 'FAMILY_ORGANIZATION_AUTHORITY_REVIEWED', targetModel: 'FamilyRelationship', targetId: familyId, category: 'COMPLIANCE_DPDP', details: { patientId: live.patient.id, grants: input.grants, revision: grant.revision } });
      return familyId;
    });
    return listFamilyAuthorizations(req, reply);
  } catch (error) { return failure(req, reply, error); }
}

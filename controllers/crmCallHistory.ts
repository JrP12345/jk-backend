import type { FastifyRequest, FastifyReply } from 'fastify';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { Location } from '../models/Location.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { Appointment } from '../models/Appointment.ts';
import { inquiryAuthority } from './crmInquiry.ts';
import { crmPatientAuthority } from '../services/CrmAuthorityService.ts';
import { checkLocationAccess } from '../utilities/tenant.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';
import { requestHasAnyPermission } from '../utilities/permissions.ts';

async function subject(req: FastifyRequest, input: any) {
  if (!!input.patientId === !!input.inquiryId) throw new CommandError(400, 'Choose one explicit patient or inquiry subject');
  if (input.inquiryId) {
    const authority = await inquiryAuthority(req, input.inquiryId);
    if (input.locationId && input.locationId !== String(authority.inquiry.locationId)) throw new CommandError(400, 'Use the inquiry branch for this call record');
    return { ...authority, patientId: authority.inquiry.patientId?.toString(), inquiryId: authority.inquiry.id, locationId: String(authority.inquiry.locationId) };
  }
  const authority = await crmPatientAuthority(req, input.patientId);
  return { ...authority, patientId: input.patientId, inquiryId: undefined, locationId: input.locationId };
}
function fail(req: FastifyRequest, reply: FastifyReply, error: any) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, 'CRM call history failed');
  return reply.code(503).send(errorResponse('The call record result could not be confirmed. Retry the same submitted record.'));
}
function dto(row: any) {
  return { id: row.id, outcome: row.outcome, note: row.get('note'), actorName: row.actorId?.name || 'Staff', communication: row.communication, locationId: String(row.locationId), createdAt: row.createdAt };
}
export async function listCrmCalls(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = req.query as any, authority = await subject(req, input);
    const filter: any = { organizationId: authority.organizationId, kind: 'call_recorded', visibility: 'administrative', ...(authority.inquiryId ? { inquiryId: authority.inquiryId } : { patientId: authority.patientId }), ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }), ...(input.cursor ? { _id: { $lt: input.cursor } } : {}) };
    const rows = await CrmActivity.find(filter).select('+note').populate('actorId', 'name').sort({ _id: -1 }).limit(21);
    return reply.send(successResponse({ items: rows.slice(0, 20).map(dto), nextCursor: rows.length > 20 ? rows[19].id : null }));
  } catch (error) { return fail(req, reply, error); }
}
export async function recordCrmCall(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before recording calls');
    const input = req.body as any;
    if (input.subjectVerified !== true) throw new CommandError(400, 'Review the selected subject before recording a call; shared contact alone is not identity');
    const result = await executeRecordedCommand(`crm-call:${req.user!.organization_id}:${req.user!.id}`, input.clientRequestId, input, async () => {
      const authority = await subject(req, input);
      if ('inquiry' in authority && authority.inquiry.ownerId?.toString() !== authority.actorId && !await requestHasAnyPermission(req, 'ASSIGN_CRM_TASKS')) throw new CommandError(403, 'Only the inquiry owner or authorized manager may record its call');
      const locationId = authority.locationId;
      if (!locationId) throw new CommandError(400, 'Choose the branch where the call was handled');
      const branch = await checkLocationAccess(req, locationId, { requireExplicitScope: true });
      if (!branch.allowed || branch.organizationId !== authority.organizationId || !await Location.exists({ _id: locationId, organizationId: authority.organizationId, isActive: true })) throw new CommandError(404, 'Branch not available');
      if (!authority.inquiryId && !await PatientRelationship.exists({ organizationId: authority.organizationId, locationId, patientId: authority.patientId, status: 'active' }) && !await Appointment.exists({ organizationId: authority.organizationId, locationId, patientId: authority.patientId })) throw new CommandError(404, 'Patient is not associated with this branch');
      const occurredAt = new Date(input.occurredAt);
      if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getTime() > Date.now() + 60000 || occurredAt.getTime() < Date.now() - 365 * 86400000) throw new CommandError(400, 'Choose a call time in the last year');
      if (input.outcome === 'other' && !input.note?.trim()) throw new CommandError(400, 'Explain the other call outcome');
      const activity = await CrmActivity.create({ organizationId: authority.organizationId, locationId, patientId: authority.patientId, inquiryId: authority.inquiryId, actorId: authority.actorId, kind: 'call_recorded', outcome: input.outcome, note: input.note?.trim(), communication: { channel: 'phone', direction: input.direction, source: 'staff_reported', occurredAt } });
      await AuditLog.create({ userId: authority.actorId, organizationId: authority.organizationId, action: 'CRM_CALL_RECORDED', targetId: activity._id, targetModel: 'CrmActivity', category: 'ADMIN', details: { locationId, patientId: authority.patientId, inquiryId: authority.inquiryId, direction: input.direction, source: 'staff_reported' } });
      return activity.id;
    });
    const authority = await subject(req, input);
    const record = await CrmActivity.findOne({ _id: result.resultId, organizationId: authority.organizationId, ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }) }).select('+note').populate('actorId', 'name');
    if (!record) throw new CommandError(404, 'Call record is no longer in your scope');
    return reply.code(result.replayed ? 200 : 201).send(successResponse({ ...dto(record), replayed: result.replayed }, 'Staff-reported call saved or restored'));
  } catch (error) { return fail(req, reply, error); }
}

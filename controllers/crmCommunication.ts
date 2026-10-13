import type { FastifyReply, FastifyRequest } from 'fastify';
import { crmPatientAuthority } from '../services/CrmAuthorityService.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { patientCommunicationPolicy, CommunicationPolicyError, type PatientCommunicationPurpose } from '../services/PatientCommunicationPolicy.ts';
import { enqueueCommunicationTemplate, enqueueTransactionalEmail } from '../services/CommunicationOutbox.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { Location } from '../models/Location.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { checkLocationAccess } from '../utilities/tenant.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';
function failure(req: FastifyRequest, reply: FastifyReply, error: any) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  if (error instanceof CommunicationPolicyError) return reply.code(409).send(errorResponse('Message blocked: review current consent, recipient and communication preferences.', { reason: error.reason }));
  req.log.error({ err: error }, 'CRM communication command failed');
  return reply.code(503).send(errorResponse('The queued message could not be confirmed. Retry the same submitted request.'));
}
function dto(row: any) {
  return { id: row.id, channel: row.payload.channel || 'email', purpose: row.payload.purpose || 'care_operations', status: row.status, attempts: row.attempts, reason: row.error || null, createdAt: row.createdAt, acceptedAt: row.acceptedAt, sentAt: row.sentAt, deliveredAt: row.deliveredAt, readAt: row.readAt };
}
export async function listPatientMessages(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = req.query as any, authority = await crmPatientAuthority(req, input.patientId);
    const rows = await OutboundMessage.find({ 'payload.organizationId': authority.organizationId, 'payload.patientId': input.patientId, ...(authority.allLocations ? {} : { 'payload.locationId': { $in: authority.locationIds } }), ...(input.cursor ? { _id: { $lt: input.cursor } } : {}) }).sort({ _id: -1 }).limit(21);
    return reply.send(successResponse({ items: rows.slice(0, 20).map(dto), nextCursor: rows.length > 20 ? rows[19].id : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function queuePatientMessage(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before sending patient messages');
    const input = req.body as any;
    if (input.subjectVerified !== true) throw new CommandError(400, 'Review the canonical patient and recipient before queuing a message');
    const authority = await crmPatientAuthority(req, input.patientId);
    const result = await executeRecordedCommand(`crm-message:${authority.organizationId}:${authority.actorId}`, input.clientRequestId, input, async () => {
      const live = await crmPatientAuthority(req, input.patientId);
      const scope = await checkLocationAccess(req, input.locationId, { requireExplicitScope: true });
      if (!scope.allowed || scope.organizationId !== live.organizationId) throw new CommandError(404, 'Branch not available');
      const context = { organizationId: live.organizationId, locationId: input.locationId, patientId: input.patientId, actorId: live.actorId, taskId: input.taskId, recipientHash: input.recipientHash, purpose: input.purpose as PatientCommunicationPurpose };
      const decision = await patientCommunicationPolicy(context, input.channel);
      const branch = await Location.findOne({ _id: input.locationId, organizationId: live.organizationId }).select('name');
      if (!branch) throw new CommandError(404, 'Branch not available');
      const clinicName = branch.name, idempotencyKey = `crm-message:${live.organizationId}:${live.actorId}:${input.clientRequestId}`;
      const topic = input.purpose === 'care_followup' ? 'a recommended care follow-up' : input.purpose === 'feedback' ? 'your feedback' : 'your service request';
      const queued = input.channel === 'email'
        ? await enqueueTransactionalEmail({ to: decision.recipient, subject: `Please contact ${clinicName}`, text: `Please contact ${clinicName} about ${topic}.`, html: `<p>Please contact your clinic about ${topic}.</p>`, idempotencyKey, communicationContext: decision.context })
        : await enqueueCommunicationTemplate({ organizationId: live.organizationId, phone: decision.recipient, channel: 'whatsapp', templateId: input.purpose === 'care_followup' ? 'CRM_CARE_FOLLOWUP' : input.purpose === 'feedback' ? 'CRM_FEEDBACK_REQUEST' : 'CRM_CONTACT_REQUEST', variables: { clinicName }, idempotencyKey, communicationContext: decision.context });
      if (!queued) throw new Error('Queue persistence failed');
      await CrmActivity.create({ organizationId: live.organizationId, locationId: input.locationId, patientId: input.patientId, taskId: input.taskId, actorId: live.actorId, kind: 'communication_queued', outcome: input.purpose, communication: { channel: input.channel, direction: 'outbound', source: 'staff_reported', occurredAt: new Date() } });
      await AuditLog.create({ organizationId: live.organizationId, userId: live.actorId, action: 'CRM_COMMUNICATION_QUEUED', targetId: queued._id, targetModel: 'OutboundMessage', category: 'ADMIN', details: { patientId: input.patientId, locationId: input.locationId, channel: input.channel, purpose: input.purpose } });
      return queued.id;
    });
    const live = await crmPatientAuthority(req, input.patientId);
    const message = await OutboundMessage.findOne({ _id: result.resultId, 'payload.organizationId': live.organizationId, 'payload.patientId': input.patientId, ...(live.allLocations ? {} : { 'payload.locationId': { $in: live.locationIds } }) });
    if (!message) throw new CommandError(404, 'Message no longer available in your branches');
    return reply.code(result.replayed ? 200 : 202).send(successResponse({ ...dto(message), replayed: result.replayed }, 'Message queued or restored; delivery is not confirmed'));
  } catch (error) { return failure(req, reply, error); }
}
export async function previewPatientMessage(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = req.query as any, authority = await crmPatientAuthority(req, input.patientId);
    const branch = await checkLocationAccess(req, input.locationId, { requireExplicitScope: true });
    if (!branch.allowed || branch.organizationId !== authority.organizationId) throw new CommandError(404, 'Branch not available');
    const decision = await patientCommunicationPolicy({ organizationId: authority.organizationId, locationId: input.locationId, patientId: input.patientId, actorId: authority.actorId, purpose: input.purpose, taskId: input.taskId }, input.channel);
    return reply.send(successResponse({ recipient: decision.recipient, recipientHash: decision.context.recipientHash, channel: input.channel, purpose: input.purpose }));
  } catch (error) { return failure(req, reply, error); }
}

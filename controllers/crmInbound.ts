import type { FastifyReply, FastifyRequest } from 'fastify';
import { WhatsAppInboundMessage } from '../models/WhatsAppInboundMessage.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { crmAuthority, crmPatientAuthority } from '../services/CrmAuthorityService.ts';
import { inquiryAuthority } from './crmInquiry.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { requestHasAnyPermission } from '../utilities/permissions.ts';
import { decryptField } from '../utilities/cryptoEnvelope.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';
async function scope(req: FastifyRequest, shared = false) {
  if (shared) {
    if (req.user?.role !== 'root') throw new CommandError(403, 'Shared-sender quarantine requires explicit platform routing');
    return { organizationId: null, locationFilter: {} };
  }
  const authority = await crmAuthority(req);
  const manager = await requestHasAnyPermission(req, 'ASSIGN_CRM_TASKS');
  return { organizationId: authority.organizationId, locationFilter: authority.allLocations ? {} : manager ? { $or: [{ locationId: { $in: authority.locationIds } }, { locationId: null }] } : { locationId: { $in: authority.locationIds } } };
}
function dto(row: any) {
  const payload = JSON.parse(decryptField(row.payloadCiphertext));
  const text = String(payload.text?.body || payload.button?.text || payload.interactive?.button_reply?.title || payload.interactive?.list_reply?.title || '').slice(0, 1000);
  return { id: row.id, revision: row.revision || 0, organizationId: row.organizationId?.toString() || null, locationId: row.locationId?.toString() || null, inquiryId: row.inquiryId?.toString() || null, patientId: row.patientId?.toString() || null, type: row.type, text, contactHint: String(payload.from || '').replace(/\D/g, '').slice(-4), pendingReview: row.pendingReview, createdAt: row.createdAt };
}
function failure(req: FastifyRequest, reply: FastifyReply, error: any) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, 'CRM inbound review failed');
  return reply.code(503).send(errorResponse('Message review could not be confirmed. Retry the same submitted review.'));
}
export async function listInboundMessages(req: FastifyRequest, reply: FastifyReply) {
  try {
    const input = req.query as any;
    if (input.shared && (input.inquiryId || input.patientId)) throw new CommandError(400, 'Quarantined replies have no verified subject');
    if (input.inquiryId && input.patientId) throw new CommandError(400, 'Choose one explicit reply subject');
    const authority = await scope(req, input.shared === true);
    let subjectFilter: any = { pendingReview: true };
    if (input.inquiryId) { const inquiry = await inquiryAuthority(req, input.inquiryId); subjectFilter = { inquiryId: input.inquiryId, locationId: inquiry.inquiry.locationId }; }
    if (input.patientId) { await crmPatientAuthority(req, input.patientId); subjectFilter = { patientId: input.patientId }; }
    const rows = await WhatsAppInboundMessage.find({ organizationId: authority.organizationId, ...authority.locationFilter, ...subjectFilter, expiresAt: { $gt: new Date() }, ...(input.cursor ? { _id: { $lt: input.cursor } } : {}) }).select('+payloadCiphertext').sort({ _id: -1 }).limit(21);
    return reply.send(successResponse({ items: rows.slice(0, 20).map(dto), nextCursor: rows.length > 20 ? rows[19].id : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function routeInboundMessage(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before routing messages');
    const input = req.body as any, id = (req.params as any).id;
    if (!input.subjectVerified || !input.reason?.trim()) throw new CommandError(400, 'Explicitly review the destination inquiry and record a routing reason; phone hints are not identity');
    const destination = await inquiryAuthority(req, input.inquiryId);
    if (!['open', 'in_progress'].includes(destination.inquiry.status)) throw new CommandError(409, 'Route to an active inquiry');
    const result = await executeRecordedCommand(`crm-inbound:${destination.organizationId}:${destination.actorId}`, input.clientRequestId, input, async () => {
      const live = await inquiryAuthority(req, input.inquiryId);
      if (!['open', 'in_progress'].includes(live.inquiry.status)) throw new CommandError(409, 'Inquiry is no longer active');
      const message = await WhatsAppInboundMessage.findById(id).select('+payloadCiphertext');
      if (!message || message.expiresAt! <= new Date()) throw new CommandError(404, 'Message no longer available');
      const shared = !message.organizationId;
      const visible = await scope(req, shared);
      if (!shared && message.organizationId?.toString() !== live.organizationId) throw new CommandError(404, 'Message unavailable in this workspace');
      if (!shared && !await WhatsAppInboundMessage.exists({ _id: id, organizationId: visible.organizationId, ...visible.locationFilter })) throw new CommandError(404, 'Message unavailable in your branches');
      if (message.revision !== input.expectedRevision || !message.pendingReview) throw new CommandError(409, 'Message was already reviewed. Reload before routing');
      if (live.inquiry.ownerId?.toString() !== live.actorId && !await requestHasAnyPermission(req, 'ASSIGN_CRM_TASKS')) throw new CommandError(403, 'Only the inquiry owner or an authorized manager may route this reply');
      const changed = await WhatsAppInboundMessage.updateOne({ _id: id, revision: input.expectedRevision, pendingReview: true }, { $set: { organizationId: live.organizationId, locationId: live.inquiry.locationId, inquiryId: live.inquiry._id, patientId: live.inquiry.patientId || null, pendingReview: false, reviewedBy: live.actorId, reviewedAt: new Date() }, $inc: { revision: 1 } });
      if (!changed.modifiedCount) throw new CommandError(409, 'Concurrent message review. Reload');
      await CrmActivity.create({ organizationId: live.organizationId, locationId: live.inquiry.locationId, inquiryId: live.inquiry._id, patientId: live.inquiry.patientId, actorId: live.actorId, kind: 'inbound_routed', outcome: 'staff_reviewed', note: input.reason.trim(), communication: { channel: 'whatsapp', direction: 'inbound', source: 'provider_event', occurredAt: message.createdAt } });
      await AuditLog.create({ organizationId: live.organizationId, userId: live.actorId, action: 'CRM_INBOUND_ROUTED', targetId: message._id, targetModel: 'WhatsAppInboundMessage', category: 'ADMIN', details: { inquiryId: live.inquiry.id, locationId: String(live.inquiry.locationId), sharedSender: shared } });
      return message.id;
    });
    const live = await inquiryAuthority(req, input.inquiryId);
    const message = await WhatsAppInboundMessage.findOne({ _id: result.resultId, organizationId: live.organizationId, locationId: live.inquiry.locationId }).select('+payloadCiphertext');
    if (!message) throw new CommandError(404, 'Message no longer available in this branch');
    return reply.send(successResponse({ ...dto(message), replayed: result.replayed }, 'Reply explicitly routed; patient identity and consent were not changed'));
  } catch (error) { return failure(req, reply, error); }
}

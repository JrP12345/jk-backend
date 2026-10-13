import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { Patient } from '../models/Patient.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { NotificationLog } from '../models/NotificationLog.ts';
import { WhatsAppInboundMessage } from '../models/WhatsAppInboundMessage.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { DPDPConsent } from '../models/DPDPConsent.ts';
import { TaskModel } from '../models/Task.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { CONSENT_NOTICE_VERSION, updatePatientConsents } from '../services/PatientConsentService.ts';
import { enqueueCommunicationTemplate, enqueueTransactionalEmail } from '../services/CommunicationOutbox.ts';
import { OutboundMessageDeliveryWorker } from '../services/OutboundMessageDeliveryWorker.ts';
import { whatsAppCloudApiService } from '../services/WhatsAppCloudApiService.ts';
import { emailProvider } from '../notifications/providers/emailProvider.ts';
import { patientCommunicationPolicy } from '../services/PatientCommunicationPolicy.ts';
import { processWhatsAppWebhookPayload } from '../controllers/whatsappWebhook.ts';
async function fixture() {
  const org = await Organization.create({ name: 'Dispatch clinic', city: 'Pune', plan: 'enterprise', whatsappConfig: { mode: 'dedicated' } });
  const branch = await Location.create({ name: 'Dispatch branch', city: 'Pune', organizationId: org.id });
  const actor = await User.create({ name: 'Dispatch staff', email: `${crypto.randomUUID()}@example.test`, role: 'admin' });
  await OrgMember.create({ organizationId: org.id, userId: actor.id, role: 'admin' });
  const patient = await Patient.create({ organizationId: org.id, name: 'Canonical patient', phone: '9876543210', email: 'patient@example.test' });
  const relationship = await PatientRelationship.create({ organizationId: org.id, patientId: patient.id, locationId: branch.id });
  const context = { organizationId: org.id, locationId: branch.id, patientId: patient.id, actorId: actor.id };
  const cookies = { access_token: (await createAuthSession({ id: actor.id, email: actor.email!, role: 'admin', organization_id: org.id }, { organizationId: org.id, workspaceRole: 'admin' })).accessToken };
  async function grant() { await updatePatientConsents(patient.id, org.id, ['COMMUNICATION_WHATSAPP', 'COMMUNICATION_EMAIL'].map(purpose => ({ purpose: purpose as any, status: 'GRANTED' })), { actorId: actor.id, clientRequestId: crypto.randomUUID(), expectedRevision: 0, method: 'in_person_confirmation', noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: true, note: 'Patient confirmed channel choices' }); }
  const provider = vi.spyOn(whatsAppCloudApiService, 'sendTemplateMessage').mockResolvedValue({ success: true, status: 'accepted', providerMessageId: 'wamid.crm-test' });
  vi.spyOn(whatsAppCloudApiService, 'sendFreeformTextMessage').mockResolvedValue({ success: true, status: 'accepted', providerMessageId: 'wamid.crm-freeform' });
  const email = vi.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true);
  const worker = new OutboundMessageDeliveryWorker();
  const payload = { patientId: patient.id, locationId: branch.id, clientRequestId: crypto.randomUUID(), channel: 'whatsapp', purpose: 'care_operations', subjectVerified: true };
  return { org, branch, actor, patient, relationship, context, cookies, provider, email, worker, payload, grant, queue: () => enqueueCommunicationTemplate({ phone: patient.phone!, organizationId: org.id, communicationContext: context, templateId: 'CRM_CONTACT_REQUEST', variables: { clinicName: branch.name }, idempotencyKey: `test:${crypto.randomUUID()}` }), save: async (extra = {}) => app.inject({ method: 'POST', url: '/api/crm/communications/messages', cookies, payload: { ...payload, recipientHash: (await patientCommunicationPolicy(context, 'whatsapp')).context.recipientHash, ...extra } }) };
}
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => { await OutboundMessage.deleteMany({}); await NotificationLog.deleteMany({}); });
describe('Approved patient dispatch and receipt integration', () => {
  it('atomically queues a minimal message with exact replay and no synchronous provider call', async () => {
    const f = await fixture(); await f.grant();
    const rows = await Promise.all([f.save(), f.save()]);
    expect(rows.map(row => row.statusCode).sort()).toEqual([200, 202]);
    expect(rows[0].json().data.status).toBe('pending'); expect(f.provider).not.toHaveBeenCalled();
    expect(await OutboundMessage.countDocuments({ 'payload.patientId': f.patient.id })).toBe(1);
    expect(await CrmActivity.countDocuments({ patientId: f.patient.id, kind: 'communication_queued' })).toBe(1);
    expect(JSON.stringify(rows[0].json())).not.toContain(f.patient.phone);
    expect((await f.save({ purpose: 'feedback' })).statusCode).toBe(409);
  });
  it('rolls back the queue and timeline if the audit fails, then restores the original command', async () => {
    const f = await fixture(); await f.grant(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit outage'));
    expect((await f.save()).statusCode).toBe(503); expect(await OutboundMessage.countDocuments()).toBe(0);
    expect(await CrmActivity.countDocuments({ organizationId: f.org.id, kind: 'communication_queued' })).toBe(0);
    expect((await f.save()).statusCode).toBe(202);
  });
  it('rolls patient email outbox persistence back with the command audit', async () => {
    const f = await fixture(); await f.grant(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit outage'));
    const recipientHash = (await patientCommunicationPolicy(f.context, 'email')).context.recipientHash;
    expect((await f.save({ channel: 'email', recipientHash })).statusCode).toBe(503);
    expect(await OutboundMessage.countDocuments({ 'payload.patientId': f.patient.id })).toBe(0);
    expect((await f.save({ channel: 'email', recipientHash })).statusCode).toBe(202);
  });
  it.each(['withdrawal', 'correction', 'revocation', 'archive'])('suppresses %s after queueing without contacting a provider', async scenario => {
    const f = await fixture(); await f.grant(); const queued = await f.queue();
    if (scenario === 'withdrawal') await updatePatientConsents(f.patient.id, f.org.id, [{ purpose: 'COMMUNICATION_WHATSAPP', status: 'WITHDRAWN' }], { actorId: f.actor.id, clientRequestId: crypto.randomUUID(), expectedRevision: 1, method: 'in_person_confirmation', noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: false, note: 'Patient withdrew WhatsApp messages' });
    if (scenario === 'correction') await PatientRelationship.updateOne({ _id: f.relationship.id }, { 'contact.phone': '9876543211' });
    if (scenario === 'revocation') await OrgMember.deleteOne({ userId: f.actor.id });
    if (scenario === 'archive') await PatientRelationship.updateOne({ _id: f.relationship.id }, { status: 'archived' });
    await f.worker.processBatch(1);
    expect((await OutboundMessage.findById(queued!._id))?.status).toBe('suppressed'); expect(f.provider).not.toHaveBeenCalled();
    expect((await OutboundMessage.findById(queued!._id))?.sentAt).toBeUndefined();
  });
  it('records provider acceptance separately, reconciles out-of-order receipts and never sends twice', async () => {
    const f = await fixture(); await f.grant(); const queued = await f.queue(); await f.worker.processBatch(1);
    const accepted = await OutboundMessage.findById(queued!._id); expect(accepted?.status).toBe('accepted'); expect(accepted?.acceptedAt).toBeInstanceOf(Date); expect(accepted?.sentAt).toBeUndefined();
    const receipt = (status: string) => processWhatsAppWebhookPayload({ entry: [{ owner: { scope: f.org.id, organizationId: f.org.id }, changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.crm-test', status }] } }] }] });
    await receipt('read'); await receipt('sent'); await receipt('delivered'); await receipt('failed');
    expect((await OutboundMessage.findById(queued!._id))?.status).toBe('read'); expect((await NotificationLog.findOne({ metaMessageId: 'wamid.crm-test' }))?.status).toBe('read');
    await f.worker.processBatch(1); expect(f.provider).toHaveBeenCalledTimes(1);
  });
  it('pins email recipients and distinguishes SMTP acceptance from delivery', async () => {
    const f = await fixture(); await f.grant();
    const queued = await enqueueTransactionalEmail({ to: f.patient.email!, subject: 'Please contact clinic', text: 'Please contact clinic', html: '<p>Please contact clinic</p>', idempotencyKey: crypto.randomUUID(), communicationContext: f.context });
    await f.worker.processBatch(1); expect((await OutboundMessage.findById(queued!._id))?.status).toBe('accepted'); expect(f.email).toHaveBeenCalledTimes(1);
    const next = await enqueueTransactionalEmail({ to: f.patient.email!, subject: 'Please contact clinic', text: 'Please contact clinic', html: '<p>Please contact clinic</p>', idempotencyKey: crypto.randomUUID(), communicationContext: f.context });
    await PatientRelationship.updateOne({ _id: f.relationship.id }, { 'contact.email': 'changed@example.test' });
    await f.worker.processBatch(1); expect((await OutboundMessage.findById(next!._id))?.status).toBe('suppressed'); expect(f.email).toHaveBeenCalledTimes(1);
  });
  it('quarantines shared-sender replies without matching contacts, creating accounts or granting consent', async () => {
    const f = await fixture(); const users = await User.countDocuments(), patients = await Patient.countDocuments(), consents = await DPDPConsent.countDocuments();
    const event = (id: string, text: string) => processWhatsAppWebhookPayload({ entry: [{ owner: { scope: 'platform' }, changes: [{ field: 'messages', value: { messages: [{ id, from: '919876543210', type: 'text', text: { body: text } }] } }] }] });
    await event('reply1', 'Please send my prescription'); await event('reply1', 'Please send my prescription'); await event('start1', 'START');
    const reply = await WhatsAppInboundMessage.findOne({ wamid: 'reply1' }); expect(reply?.pendingReview).toBe(true); expect(reply?.organizationId).toBeFalsy(); expect(reply?.patientId).toBeUndefined();
    expect(await WhatsAppInboundMessage.countDocuments({ wamid: 'reply1' })).toBe(1); expect(await User.countDocuments()).toBe(users); expect(await Patient.countDocuments()).toBe(patients); expect(await DPDPConsent.countDocuments()).toBe(consents); expect(f.provider).not.toHaveBeenCalled();
  });
  it('creates one manual review task after a permanent provider failure and resolves it on positive delivery evidence', async () => {
    const f = await fixture(); await f.grant(); const queued = await f.queue();
    f.provider.mockResolvedValue({ success: false, status: 'failed', errorReason: 'RECIPIENT_NOT_ON_WHATSAPP', providerMessageId: 'wamid.crm-test' });
    await f.worker.processBatch(1);
    expect((await OutboundMessage.findById(queued!._id))?.status).toBe('failed');
    const filter = { organizationId: f.org.id, dedupeKey: `communication-recovery:${queued!.id}` };
    const task = await TaskModel.findOne(filter); expect(task?.kind).toBe('crm_review'); expect(task?.status).toBe('todo');
    await f.worker.processBatch(1); expect(await TaskModel.countDocuments(filter)).toBe(1);
    await processWhatsAppWebhookPayload({ entry: [{ owner: { scope: f.org.id, organizationId: f.org.id }, changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.crm-test', status: 'read' }] } }] }] });
    expect((await TaskModel.findOne(filter))?.outcome).toBe('message_delivery_confirmed'); expect((await OutboundMessage.findById(queued!._id))?.status).toBe('read');
  });
  it('leaves terminal state uncommitted if recovery task persistence fails, then recovers without sending', async () => {
    const f = await fixture(); await f.grant(); const queued = await f.queue(); await PatientRelationship.updateOne({ _id: f.relationship.id }, { 'contact.phone': '9876543211' });
    vi.spyOn(CrmActivity, 'updateOne').mockRejectedValueOnce(new Error('timeline outage')); await f.worker.processBatch(1);
    expect((await OutboundMessage.findById(queued!._id))?.status).toBe('processing'); expect(await TaskModel.countDocuments({ organizationId: f.org.id, dedupeKey: `communication-recovery:${queued!.id}` })).toBe(0);
    await OutboundMessage.updateOne({ _id: queued!._id }, { lockedUntil: new Date(0) }); await f.worker.processBatch(1);
    expect((await OutboundMessage.findById(queued!._id))?.status).toBe('suppressed'); expect(f.provider).not.toHaveBeenCalled();
  });
  it('reconciles a ledger receipt after a prior crash even when the replayed event is older', async () => {
    const f = await fixture(); await f.grant(); const queued = await f.queue(); await f.worker.processBatch(1);
    await NotificationLog.updateOne({ metaMessageId: 'wamid.crm-test' }, { status: 'read', readAt: new Date() });
    await processWhatsAppWebhookPayload({ entry: [{ owner: { scope: f.org.id, organizationId: f.org.id }, changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.crm-test', status: 'failed' }] } }] }] });
    expect((await OutboundMessage.findById(queued!._id))?.status).toBe('read'); expect(await TaskModel.countDocuments({ organizationId: f.org.id, dedupeKey: `communication-recovery:${queued!.id}` })).toBe(0);
  });
  it('never automatically retries an uncertain patient SMTP acceptance or a crashed email attempt', async () => {
    const f = await fixture(); await f.grant(); f.email.mockResolvedValue(false);
    const queued = await enqueueTransactionalEmail({ to: f.patient.email!, subject: 'Clinic contact', text: 'Please contact clinic', html: '<p>Please contact clinic</p>', idempotencyKey: crypto.randomUUID(), communicationContext: f.context });
    await f.worker.processBatch(1); expect((await OutboundMessage.findById(queued!._id))?.status).toBe('failed'); expect(f.email).toHaveBeenCalledTimes(1);
    await OutboundMessage.updateOne({ _id: queued!._id }, { status: 'pending', nextAttemptAt: new Date(0) }); await f.worker.processBatch(1); expect(f.email).toHaveBeenCalledTimes(1);
    expect((await OutboundMessage.findById(queued!._id))?.error).toBe('EMAIL_ACCEPTANCE_UNCONFIRMED');
  });
});

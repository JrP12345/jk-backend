import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Inquiry } from '../models/Inquiry.ts';
import { WhatsAppInboundMessage } from '../models/WhatsAppInboundMessage.ts';
import { WhatsAppRecipient } from '../models/WhatsAppRecipient.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { processWhatsAppWebhookPayload } from '../controllers/whatsappWebhook.ts';
import { phoneHash } from '../services/WhatsAppSendPolicy.ts';
async function fixture(root = false) {
  const org = await Organization.create({ name: 'Inbox', city: 'Pune', plan: 'enterprise' });
  const branch = await Location.create({ organizationId: org.id, name: 'Inbox branch', city: 'Pune' });
  const actor = await User.create({ name: 'Inbox staff', email: `${crypto.randomUUID()}@example.test`, role: root ? 'root' : 'admin' });
  if (!root) await OrgMember.create({ organizationId: org.id, userId: actor.id, role: 'admin' });
  const session = await createAuthSession({ id: actor.id, email: actor.email!, role: root ? 'root' : 'admin', ...(!root ? { organization_id: org.id } : {}) }, root ? undefined : { organizationId: org.id, workspaceRole: 'admin' });
  const cookies = { access_token: session.accessToken };
  const inquiry = await Inquiry.create({ organizationId: org.id, locationId: branch.id, createdBy: actor.id, ownerId: root ? undefined : actor.id, callerName: 'Reviewed caller', nextAction: { kind: 'review', dueAt: new Date() } });
  const messageId = crypto.randomUUID();
  const event = (id: string = messageId, text = 'Please review my service request', timestamp = Math.floor(Date.now() / 1000)) => ({ entry: [{ owner: { scope: root ? 'platform' : org.id, ...(!root ? { organizationId: org.id } : {}) }, changes: [{ field: 'messages', value: { messages: [{ id, from: '919876543210', timestamp: String(timestamp), type: 'text', text: { body: text } }] } }] }] });
  await processWhatsAppWebhookPayload(event());
  const message = (await WhatsAppInboundMessage.findOne({ wamid: messageId }))!;
  const payload = { organizationId: org.id, inquiryId: inquiry.id, expectedRevision: 0, clientRequestId: crypto.randomUUID(), subjectVerified: true, reason: 'Caller and destination inquiry reviewed by staff' };
  const save = (extra = {}) => app.inject({ method: 'POST', url: `/api/crm/communications/inbound/${message.id}/route`, cookies, payload: { ...payload, ...extra } });
  return { org, branch, actor, inquiry, message, cookies, event, payload, save };
}
afterEach(() => vi.restoreAllMocks());
describe('Explicit inbound communication routing', () => {
  it('routes dedicated replies atomically to a reviewed inquiry and restores exact retries', async () => {
    const f = await fixture(); const responses = await Promise.all([f.save(), f.save()]); expect(responses.map(row => row.statusCode)).toEqual([200, 200]);
    const row = await WhatsAppInboundMessage.findById(f.message.id); expect(row?.inquiryId?.toString()).toBe(f.inquiry.id); expect(row?.patientId).toBeNull(); expect(row?.pendingReview).toBe(false); expect(row?.revision).toBe(1);
    expect(await CrmActivity.countDocuments({ inquiryId: f.inquiry.id, kind: 'inbound_routed' })).toBe(1);
    const history = await app.inject({ method: 'GET', url: `/api/crm/communications/inbound?inquiryId=${f.inquiry.id}`, cookies: f.cookies });
    expect(history.statusCode).toBe(200); expect(history.json().data.items).toHaveLength(1); expect(history.json().data.items[0].text).toBe('Please review my service request');
    await processWhatsAppWebhookPayload(f.event());
    const replay = await WhatsAppInboundMessage.findById(f.message.id); expect(replay?.pendingReview).toBe(false); expect(replay?.inquiryId?.toString()).toBe(f.inquiry.id);
  });
  it('rolls back routing on audit outage and recovers the original request', async () => {
    const f = await fixture(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit outage'));
    expect((await f.save()).statusCode).toBe(503); expect((await WhatsAppInboundMessage.findById(f.message.id))?.pendingReview).toBe(true); expect(await CrmActivity.countDocuments({ inquiryId: f.inquiry.id })).toBe(0);
    expect((await f.save()).statusCode).toBe(200);
  });
  it('requires subject review, forbids foreign inquiries, closed destinations and concurrent rerouting', async () => {
    const f = await fixture(); expect((await f.save({ subjectVerified: false })).statusCode).toBe(400);
    const foreign = await Organization.create({ name: 'Foreign', city: 'Pune' });
    const inquiry = await Inquiry.create({ organizationId: foreign.id, locationId: f.branch.id, createdBy: f.actor.id, nextAction: { kind: 'review', dueAt: new Date() } });
    expect((await f.save({ inquiryId: inquiry.id })).statusCode).toBe(404);
    await Inquiry.updateOne({ _id: f.inquiry.id }, { status: 'closed' }); expect((await f.save()).statusCode).toBe(409);
    await Inquiry.updateOne({ _id: f.inquiry.id }, { status: 'open' }); expect((await f.save()).statusCode).toBe(200);
    expect((await f.save({ clientRequestId: crypto.randomUUID() })).statusCode).toBe(409);
  });
  it('keeps shared replies platform-only until root explicitly chooses organization and inquiry', async () => {
    const f = await fixture(true), tenant = await fixture();
    const denied = await app.inject({ method: 'GET', url: '/api/crm/communications/inbound?shared=true', cookies: tenant.cookies }); expect(denied.statusCode).toBe(403);
    const page = await app.inject({ method: 'GET', url: '/api/crm/communications/inbound?shared=true', cookies: f.cookies }); expect(page.statusCode, page.body).toBe(200); expect(page.json().data.items.some((row: any) => row.id === f.message.id)).toBe(true);
    const tenantRoute = await app.inject({ method: 'POST', url: `/api/crm/communications/inbound/${f.message.id}/route`, cookies: tenant.cookies, payload: tenant.payload }); expect(tenantRoute.statusCode).toBe(403);
    const saved = await f.save(); expect(saved.statusCode, saved.body).toBe(200);
    expect((await WhatsAppInboundMessage.findById(f.message.id))?.organizationId?.toString()).toBe(f.org.id);
  });
  it('blocks stale START from undoing a newer STOP during webhook replay', async () => {
    const f = await fixture(), now = Math.floor(Date.now() / 1000);
    await processWhatsAppWebhookPayload(f.event('stop-new', 'STOP', now)); await processWhatsAppWebhookPayload(f.event('start-old', 'START', now - 100));
    expect((await WhatsAppRecipient.findOne({ scope: f.org.id, phoneHash: phoneHash('919876543210') }))?.optedOut).toBe(true);
  });
});

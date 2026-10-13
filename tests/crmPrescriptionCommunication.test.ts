import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { User } from '../models/User.ts';
import { Appointment } from '../models/Appointment.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { patientCommunicationFixture } from './helpers/patientCommunicationFixture.ts';
import { queuePrescriptionCommunication } from '../services/PrescriptionCommunicationService.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { OutboundMessageDeliveryWorker } from '../services/OutboundMessageDeliveryWorker.ts';
import { whatsAppCloudApiService } from '../services/WhatsAppCloudApiService.ts';
import { processWhatsAppWebhookPayload } from '../controllers/whatsappWebhook.ts';
async function fixture() {
  const org = await Organization.create({ name: 'Prescription communication', city: 'Pune', plan: 'enterprise' });
  const admin = await User.create({ name: 'Prescription staff', email: `${crypto.randomUUID()}@example.test`, role: 'admin' });
  await OrgMember.create({ organizationId: org.id, userId: admin.id, role: 'admin' });
  const communication = await patientCommunicationFixture(org.id, '9876543210');
  await Appointment.updateOne({ _id: communication.appointment.id }, { status: 'completed', diagnosis: 'Private diagnosis', prescriptions: [{ name: 'Private medicine', dosage: 'Recorded dose', duration: 'Recorded duration' }] });
  const input = { organizationId: org.id, appointmentId: communication.appointment.id, actorId: admin.id, clientRequestId: crypto.randomUUID() };
  return { ...communication, org, admin, input };
}
afterEach(() => vi.restoreAllMocks());
beforeEach(async () => { await OutboundMessage.deleteMany({}); });
describe('Truthful prescription communication queue', () => {
  it('queues once, restores the same capability on exact replay and does not claim delivery', async () => {
    const f = await fixture(); const first = await queuePrescriptionCommunication(f.input);
    const capability = (await Appointment.findById(f.appointment.id))?.trackerTokenHash;
    const replay = await queuePrescriptionCommunication(f.input);
    expect(replay.outboxId).toBe(first.outboxId); expect(replay.replayed).toBe(true); expect(replay.status).toBe('pending');
    expect((await Appointment.findById(f.appointment.id))?.trackerTokenHash).toBe(capability); expect((await Appointment.findById(f.appointment.id))?.rxDispatchedAt).toBeNull();
    expect(await OutboundMessage.countDocuments({ _id: first.outboxId })).toBe(1);
    expect(JSON.stringify(first)).not.toContain('Private diagnosis'); expect(JSON.stringify(first)).not.toContain('Private medicine');
  });
  it('rejects arbitrary recipients and unfinished visits', async () => {
    const f = await fixture(); await expect(queuePrescriptionCommunication({ ...f.input, phone: '9876543211' })).rejects.toMatchObject({ reason: 'COMMUNICATION_RECIPIENT_CHANGED' });
    await Appointment.updateOne({ _id: f.appointment.id }, { status: 'confirmed' }); await expect(queuePrescriptionCommunication(f.input)).rejects.toMatchObject({ statusCode: 409 });
    expect(await OutboundMessage.countDocuments({ 'payload.patientId': f.patient.id })).toBe(0);
  });
  it('rolls back the capability, queue and audit on failure, then retries the original request', async () => {
    const f = await fixture(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('Audit outage'));
    await expect(queuePrescriptionCommunication(f.input)).rejects.toThrow('Audit outage');
    expect((await Appointment.findById(f.appointment.id))?.trackerTokenHash).toBeFalsy(); expect(await OutboundMessage.countDocuments({ 'payload.patientId': f.patient.id })).toBe(0);
    expect((await queuePrescriptionCommunication(f.input)).status).toBe('pending');
  });
  it('requires a retry key and returns accepted queue state through the existing route', async () => {
    const f = await fixture(); const cookies = { access_token: (await createAuthSession({ id: f.admin.id, email: f.admin.email!, role: 'admin', organization_id: f.org.id }, { organizationId: f.org.id, workspaceRole: 'admin' })).accessToken };
    const url = `/api/appointments/${f.appointment.id}/resend-rx`;
    expect((await app.inject({ method: 'POST', url, cookies, payload: { channel: 'whatsapp' } })).statusCode).toBe(400);
    const response = await app.inject({ method: 'POST', url, cookies, payload: { channel: 'whatsapp', clientRequestId: f.input.clientRequestId } });
    expect(response.statusCode, response.body).toBe(202); expect(response.json().data.status).toBe('pending'); expect(response.json().data).not.toHaveProperty('dispatchedAt');
  });
  it('records prescription delivery only after a verified provider receipt', async () => {
    const f = await fixture(); const queued = await queuePrescriptionCommunication(f.input);
    vi.spyOn(whatsAppCloudApiService, 'sendDocumentMessage').mockResolvedValue({ success: true, status: 'accepted', providerMessageId: 'wamid.rx-delivery' });
    await new OutboundMessageDeliveryWorker().processBatch(1);
    expect((await OutboundMessage.findById(queued.outboxId))?.status).toBe('accepted'); expect((await Appointment.findById(f.appointment.id))?.rxDispatchedAt).toBeNull();
    await processWhatsAppWebhookPayload({ entry: [{ owner: { scope: 'platform' }, changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.rx-delivery', status: 'delivered' }] } }] }] });
    expect((await Appointment.findById(f.appointment.id))?.rxDispatchedAt).toBeInstanceOf(Date);
  });
});

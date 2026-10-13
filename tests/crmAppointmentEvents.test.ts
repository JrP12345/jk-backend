import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { Subscription } from '../models/Subscription.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Organization } from '../models/Organization.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Appointment } from '../models/Appointment.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { TaskModel } from '../models/Task.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { DPDPConsent } from '../models/DPDPConsent.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { publishAppointmentCommunication, handleAppointmentCommunication } from '../services/AppointmentCommunicationEvents.ts';
import { readEncryptedDomainEvent } from '../services/DomainEventOutboxService.ts';
import { readEncryptedOutboundPayload } from '../services/CommunicationOutbox.ts';
import { patientCommunicationFixture } from './helpers/patientCommunicationFixture.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { eventBus } from '../events/eventBus.ts';
async function fixture() {
  const org = await Organization.create({ name: 'Source clinic', city: 'Mumbai', whatsappConfig: { mode: 'dedicated', notifications: { sendTurnApproaching: true, sendQueueDelayAlert: true } } });
  const actor = await User.create({ name: 'Actual staff actor', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create({ organizationId: org.id, userId: actor.id, role: 'admin' });
  await Subscription.create({ organizationId: org.id, planId: new mongoose.Types.ObjectId(), status: 'active', currentPeriodEnd: new Date(Date.now() + 86400000), trialEndsAt: new Date(Date.now() + 86400000) });
  const patient = await patientCommunicationFixture(org.id, '9876543210');
  const capture = async (action: 'booked' | 'prescription' | 'turn_approaching' | 'queue_delay' = 'booked') => {
    await withTransaction(async () => { await publishAppointmentCommunication(patient.appointment, { action, actorId: actor.id }); });
    const row = (await DomainEventOutbox.findOne({ eventType: 'crm.appointment.communication', organizationId: org.id }).sort({ _id: -1 }).select('+payloadCiphertext'))!;
    return readEncryptedDomainEvent(row);
  };
  return { org, actor, ...patient, capture };
}
beforeEach(async () => { await DomainEventOutbox.deleteMany({}); await OutboundMessage.deleteMany({}); });
afterEach(() => vi.restoreAllMocks());
describe('Appointment communication survives business commit and worker outage', () => {
  it('persists encrypted intent atomically and queues each channel once on delayed replay', async () => {
    const f = await fixture(), event = await f.capture();
    expect(await OutboundMessage.countDocuments()).toBe(0);
    expect((await DomainEventOutbox.findOne({ eventType: event.eventType }))?.get('payloadCiphertext')).toBeUndefined();
    await handleAppointmentCommunication(event); await handleAppointmentCommunication(event);
    const messages = await OutboundMessage.find({ 'payload.appointmentId': f.appointment.id });
    expect(messages).toHaveLength(2); expect(messages.every(row => row.status === 'pending')).toBe(true);
    expect(messages.every(row => row.payload.communicationRevision === 1)).toBe(true);
  });
  it('rolls business state, source revision and intent back if durable persistence fails', async () => {
    const f = await fixture();
    vi.spyOn(DomainEventOutbox, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('source outbox outage'); });
    await expect(withTransaction(async () => {
      const changed = await Appointment.findByIdAndUpdate(f.appointment.id, { status: 'cancelled' }, { returnDocument: 'after' });
      await publishAppointmentCommunication(changed, { action: 'cancelled', actorId: f.actor.id });
    })).rejects.toThrow('source outbox outage');
    const current = await Appointment.findById(f.appointment.id); expect(current?.status).toBe('confirmed'); expect(current?.communicationRevision).toBe(0);
    expect(await OutboundMessage.countDocuments()).toBe(0); expect(await DomainEventOutbox.countDocuments()).toBe(0);
  });
  it.each(['status', 'time', 'doctor', 'contact', 'actor', 'consent', 'preference', 'expiry'])('rechecks %s after an outage before creating outbound messages', async change => {
    const f = await fixture(), event = await f.capture();
    if (change === 'status') await Appointment.updateOne({ _id: f.appointment.id }, { status: 'cancelled' });
    if (change === 'time') await Appointment.updateOne({ _id: f.appointment.id }, { appointmentTime: new Date(Date.now() + 86400000) });
    if (change === 'doctor') await Appointment.updateOne({ _id: f.appointment.id }, { doctorId: f.actor.id });
    if (change === 'contact') await PatientRelationship.updateOne({ patientId: f.patient.id, organizationId: f.org.id }, { 'contact.phone': '9876543211', 'contact.email': 'changed@example.test' });
    if (change === 'actor') await OrgMember.deleteOne({ userId: f.actor.id, organizationId: f.org.id });
    if (change === 'consent') await DPDPConsent.updateOne({ patientId: f.patient.id, organizationId: f.org.id }, { $set: { 'purposes.$[].status': 'WITHDRAWN' } });
    if (change === 'preference') await PatientRelationship.updateOne({ patientId: f.patient.id, organizationId: f.org.id }, { 'preferences.doNotContact': true });
    if (change === 'expiry') await Subscription.updateOne({ organizationId: f.org.id }, { currentPeriodEnd: new Date(Date.now() - 1) });
    await handleAppointmentCommunication(event); await handleAppointmentCommunication(event);
    expect(await OutboundMessage.countDocuments()).toBe(0);
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_review' })).toBe(2);
  });
  it('keeps channel decisions independent and describes unpaid booking truthfully', async () => {
    const f = await fixture();
    await Appointment.updateOne({ _id: f.appointment.id }, { status: 'pending_payment' });
    await DPDPConsent.updateOne({ patientId: f.patient.id, organizationId: f.org.id, 'purposes.purpose': 'COMMUNICATION_EMAIL' }, { $set: { 'purposes.$.status': 'WITHDRAWN' } });
    const event = await f.capture(); await handleAppointmentCommunication(event);
    const queued = (await OutboundMessage.findOne({ 'payload.appointmentId': f.appointment.id }).select('+sensitivePayloadCiphertext'))!;
    expect(await OutboundMessage.countDocuments()).toBe(1); expect(queued.payload.templateId).toBe('CRM_CONTACT_REQUEST');
    const payload = readEncryptedOutboundPayload<any>(queued);
    expect(payload.communicationContext.appointmentStatus).toBe('pending_payment');
    expect(payload.templateId).toBe('CRM_CONTACT_REQUEST');
  });
  it('queues a prescription after completion and restores the same capability on replay', async () => {
    const f = await fixture(); await Appointment.updateOne({ _id: f.appointment.id }, { status: 'completed' });
    const event = await f.capture('prescription'); await handleAppointmentCommunication(event);
    const hash = (await Appointment.findById(f.appointment.id).select('+trackerTokenHash'))?.trackerTokenHash;
    await handleAppointmentCommunication(event);
    expect(await OutboundMessage.countDocuments({ 'payload.appointmentId': f.appointment.id })).toBe(1);
    expect((await Appointment.findById(f.appointment.id).select('+trackerTokenHash'))?.trackerTokenHash).toBe(hash);
    expect((await Appointment.findById(f.appointment.id))?.rxQueuedAt).toBeInstanceOf(Date);
    expect((await Appointment.findById(f.appointment.id))?.rxDispatchedAt).toBeNull();
    expect(await AuditLog.countDocuments({ targetId: f.appointment.id, action: 'PRESCRIPTION_NOTIFICATION_QUEUED' })).toBe(1);
  });
  it('registers the same awaited handler through the API/worker module', async () => {
    const f = await fixture(), event = await f.capture();
    expect(eventBus.listeners('crm.appointment.communication').filter(handler => handler === handleAppointmentCommunication)).toHaveLength(1);
    await eventBus.dispatch(event); expect(await OutboundMessage.countDocuments()).toBe(2);
  });
  it.each(['turn_approaching', 'queue_delay'] as const)('queues %s once and rejects a stale visit day before dispatch', async action => {
    const f = await fixture();
    if (action === 'queue_delay') await Appointment.updateOne({ _id: f.appointment.id }, { lastNotifiedDelayMinutes: 22 });
    const event = await f.capture(action);
    await handleAppointmentCommunication(event); await handleAppointmentCommunication(event);
    const row = (await OutboundMessage.findOne({ 'payload.appointmentId': f.appointment.id, kind: 'communication_template' }).select('+sensitivePayloadCiphertext'))!;
    expect(row).toBeTruthy();
    const payload = readEncryptedOutboundPayload<any>(row);
    expect(payload.templateId).toBe(action === 'queue_delay' ? 'QUEUE_DELAY_ALERT' : 'QUEUE_UPDATE');
    if (action === 'queue_delay') expect(payload.variables.delayMinutes).toBe('22');
    expect(payload.variables.trackingUrl).toContain('/track/' + f.appointment.id);
    const { patientCommunicationPolicy } = await import('../services/PatientCommunicationPolicy.ts');
    await expect(patientCommunicationPolicy(payload.communicationContext, 'whatsapp', payload.phone)).resolves.toBeTruthy();
    await Appointment.updateOne({ _id: f.appointment.id }, { appointmentTime: new Date(Date.now() - 86400000) });
    await expect(patientCommunicationPolicy({ ...payload.communicationContext, appointmentTime: undefined }, 'whatsapp', payload.phone)).rejects.toThrow('COMMUNICATION_SOURCE_CHANGED');
    expect(await OutboundMessage.countDocuments({ 'payload.appointmentId': f.appointment.id })).toBe(2);
  });

});

import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { Patient } from '../models/Patient.ts';
import { Appointment } from '../models/Appointment.ts';
import { Notification } from '../models/Notification.ts';
import { NotificationDelivery } from '../models/NotificationDelivery.ts';
import { notificationService } from '../notifications/services/NotificationService.ts';
import { NotificationDeliveryWorker } from '../notifications/workers/NotificationDeliveryWorker.ts';
import { emailProvider } from '../notifications/providers/emailProvider.ts';
import { eventBus } from '../events/eventBus.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { readEncryptedDomainEvent } from '../services/DomainEventOutboxService.ts';
import { publishAppointmentCommunication } from '../services/AppointmentCommunicationEvents.ts';
import { withTransaction } from '../utilities/transaction.ts';
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const org = await Organization.create({ name: 'Inbox clinic', city: 'Mumbai' });
  const branch = await Location.create({ name: 'Inbox branch', city: 'Mumbai', organizationId: org.id });
  const user = await User.create({ name: 'Self patient', role: 'patient', email: `${crypto.randomUUID()}@example.test` });
  const patient = await Patient.create({ organizationId: org.id, userId: user.id, name: 'Patient' });
  const appointment = await Appointment.create({ organizationId: org.id, locationId: branch.id, patientId: patient.id, doctorId: new (await import('mongoose')).default.Types.ObjectId(), appointmentTime: new Date(), appointmentType: 'reception', status: 'confirmed', tokenNumber: 1 });
  const event = { eventId: crypto.randomUUID(), eventType: 'PATIENT_APPOINTMENT_BOOKED', category: 'patient' as const, organizationId: org.id, targetUserId: user.id, title: 'Sensitive diagnosis', message: 'Private clinical content', channels: { inApp: true, email: true }, metadata: { appointmentId: appointment.id, patientId: patient.id, trackingUrl: 'https://clinic.test/#t=private-capability', requestedChannels: { email: true } } };
  return { org, branch, user, patient, appointment, event };
}
it('keeps a canonical self update in-app and cannot force generic email or expose capability/clinical content', async () => {
  const f = await fixture(); await notificationService.handleDomainEvent(f.event); await notificationService.handleDomainEvent(f.event);
  const rows = await Notification.find({ targetUser: f.user.id }); expect(rows).toHaveLength(1);
  expect(rows[0].title).toBe('Visit update'); expect(JSON.stringify(rows)).not.toContain('Private clinical'); expect(JSON.stringify(rows)).not.toContain('private-capability');
  expect(rows[0].actionUrl).toBe(`/dashboard/appointments?appointmentId=${f.appointment.id}`);
  expect(await NotificationDelivery.countDocuments({ notificationId: rows[0]._id, channel: 'email' })).toBe(0);
});
it('rechecks the actual owner, organization, branch and pinned visit revision before inbox replay', async () => {
  const f = await fixture();
  await notificationService.handleDomainEvent({ ...f.event, organizationId: new (await import('mongoose')).default.Types.ObjectId().toString() });
  await notificationService.handleDomainEvent({ ...f.event, metadata: { ...f.event.metadata, context: { communicationRevision: 9 } } });
  await Location.updateOne({ _id: f.branch.id }, { isActive: false }); await notificationService.handleDomainEvent(f.event);
  await Location.updateOne({ _id: f.branch.id }, { isActive: true });
  await Patient.updateOne({ _id: f.patient.id }, { $unset: { userId: 1 } }); await notificationService.handleDomainEvent(f.event);
  expect(await Notification.countDocuments({ targetUser: f.user.id })).toBe(0);
});
it('preserves account security notifications while suppressing old patient email deliveries without a provider attempt', async () => {
  const f = await fixture(), provider = vi.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true);
  const legacy = await Notification.create({ targetUser: f.user.id, organizationId: f.org.id, category: 'patient', type: f.event.eventType, title: 'Old patient email', message: 'Old private text', metadata: f.event.metadata });
  const delivery = await NotificationDelivery.create({ notificationId: legacy.id, channel: 'email', recipient: f.user.email!, title: legacy.title, message: legacy.message, status: 'pending', nextAttemptAt: new Date() });
  const worker = new NotificationDeliveryWorker(); await worker.processBatch(1);
  expect(provider).not.toHaveBeenCalled(); expect((await NotificationDelivery.findById(delivery.id))?.status).toBe('suppressed');
  await notificationService.handleDomainEvent({ eventId: crypto.randomUUID(), eventType: 'AUTH_PASSWORD_CHANGED', category: 'security', targetUserId: f.user.id, title: 'Password changed', message: 'Your password changed.', channels: { inApp: true, email: true }, metadata: { requestedChannels: { email: true } } });
  await worker.processBatch(1); expect(provider).toHaveBeenCalledTimes(1);
});
it('publishes a durable self inbox intent in the booking transaction even when external channels lack consent', async () => {
  const f = await fixture(); await withTransaction(() => publishAppointmentCommunication(f.appointment, { action: 'booked' }));
  const row = (await DomainEventOutbox.findOne({ organizationId: f.org.id, eventType: 'crm.appointment.inbox' }).select('+payloadCiphertext'))!;
  expect(row).toBeTruthy(); const event = readEncryptedDomainEvent(row);
  await eventBus.dispatch(event); expect(await Notification.countDocuments({ targetUser: f.user.id })).toBe(1);
  await Appointment.updateOne({ _id: f.appointment.id }, { $inc: { communicationRevision: 1 } });
  await notificationService.handleDomainEvent({ ...event, eventId: crypto.randomUUID() });
  expect(await Notification.countDocuments({ targetUser: f.user.id })).toBe(1);
});

import type mongoose from 'mongoose';
import type { DomainEventPayload } from '../events/types.ts';
import { eventBus } from '../events/eventBus.ts';
import { Appointment } from '../models/Appointment.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { Patient } from '../models/Patient.ts';
import { Organization } from '../models/Organization.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { patientCommunicationPolicy, CommunicationPolicyError, type PatientCommunicationContext } from './PatientCommunicationPolicy.ts';
import { createCrmTask } from './CrmTaskService.ts';
import { enqueueCommunicationTemplate, enqueueTransactionalEmail } from './CommunicationOutbox.ts';
import { queuePrescriptionCommunication } from './PrescriptionCommunicationService.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { getLocationTimezone } from '../utilities/locationTime.ts';
import { escapeHtml } from '../utilities/manualNotificationContent.ts';
import { issueAppointmentTrackerLink } from '../utilities/publicTracker.ts';
import { locationDateKey, locationDayRange } from '../utilities/locationTime.ts';

type AppointmentCommunicationAction = Exclude<NonNullable<PatientCommunicationContext['communicationAction']>, 'queue_tracker'>;
const ref = (value: any) => String(value?._id || value);
async function review(context: PatientCommunicationContext, key: string) {
  if (!await Location.exists({ _id: context.locationId, organizationId: context.organizationId, isActive: true })) return;
  const relationship = await PatientRelationship.findOne({ organizationId: context.organizationId, patientId: context.patientId, locationId: context.locationId, status: 'active' }).select('ownerId').lean();
  await createCrmTask({ organizationId: context.organizationId, locationId: context.locationId!, patientId: context.patientId, appointmentId: context.appointmentId, actorId: context.actorId, kind: 'crm_review', title: 'Review unavailable appointment communication', dueDate: new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `communication-event-review:${key}` });
}
// Invoked in the business transaction. Pin the actual subject, source state and
// current consent evidence before commit; a later grant cannot revive this event.
export async function publishAppointmentCommunication(appointment: any, input: { action: AppointmentCommunicationAction; actorId?: string; intendedPhone?: string }, session?: mongoose.ClientSession | null) {
  const organizationId = ref(appointment.organizationId), appointmentId = ref(appointment._id);
  const source = await Appointment.findOneAndUpdate({ _id: appointmentId, organizationId }, { $inc: { communicationRevision: 1 } }, { returnDocument: 'after', ...(session ? { session } : {}) });
  if (!source) throw new Error('Appointment communication source missing');
  appointment.communicationRevision = source.communicationRevision;
  const context: PatientCommunicationContext = { organizationId, appointmentId, patientId: ref(source.patientId), locationId: ref(source.locationId), actorId: input.actorId, purpose: 'care_operations', communicationAction: input.action, automated: true };
  const channels: { channel: 'whatsapp' | 'email'; context: PatientCommunicationContext }[] = [];
  for (const channel of input.action === 'prescription' ? ['whatsapp'] as const : ['whatsapp', 'email'] as const) {
    try { channels.push({ channel, context: (await patientCommunicationPolicy(context, channel, channel === 'whatsapp' ? input.intendedPhone : undefined)).context }); }
    catch (error) { if (!(error instanceof CommunicationPolicyError)) throw error; }
  }
  const key = `crm:appointment:${appointmentId}:${source.communicationRevision}:${input.action}`;
  if (!channels.length) await review(context, key);
  const patient = await Patient.findById(source.patientId).select('userId').setOptions({ bypassTenantFilter: true }).lean();
  if (patient?.userId) await eventBus.publishDurable({ eventId: `${key}:inApp`, eventType: 'crm.appointment.inbox', category: 'patient', organizationId, createdBy: input.actorId, targetUserId: String(patient.userId),
    title: 'Visit update', message: 'Open your appointments to review the current visit.', channels: { inApp: true, email: false, sms: false, push: false },
    metadata: { appointmentId, patientId: String(source.patientId), context: { communicationRevision: source.communicationRevision } } }, session);
  await eventBus.publishDurable({ eventId: key, eventType: 'crm.appointment.communication', category: 'patient', organizationId, createdBy: input.actorId, metadata: { action: input.action, context, channels } }, session);
}

export async function handleAppointmentCommunication(event: DomainEventPayload) {
  const metadata = event.metadata;
  if (!event.eventId || !event.organizationId || !metadata?.context || metadata.context.organizationId !== event.organizationId || !Array.isArray(metadata.channels)) throw new Error('Invalid appointment communication event');
  for (const entry of metadata.channels) await withTransaction(async () => {
    if (!['whatsapp', 'email'].includes(entry.channel) || entry.context?.organizationId !== event.organizationId || entry.context?.appointmentId !== metadata.context.appointmentId || !entry.context?.recipientHash || !entry.context?.consentEvidenceHash) throw new Error('Invalid pinned communication context');
    const key = `${event.eventId}:${entry.channel}`;
    if (await OutboundMessage.exists({ idempotencyKey: key, 'payload.organizationId': event.organizationId })) return;
    try {
      const decision = await patientCommunicationPolicy(entry.context, entry.channel);
      const appointment = await Appointment.findOne({ _id: decision.context.appointmentId, organizationId: event.organizationId });
      if (!appointment) throw new CommunicationPolicyError('COMMUNICATION_SOURCE_CHANGED');
      const queueAction = ['turn_approaching', 'queue_delay'].includes(metadata.action);
      const zone = await getLocationTimezone(String(appointment.locationId));
      if (queueAction && (!['pending', 'confirmed', 'checked-in'].includes(appointment.status) || locationDateKey(appointment.appointmentTime, zone) !== locationDateKey(new Date(), zone))) throw new CommunicationPolicyError('COMMUNICATION_SOURCE_CHANGED');
      if (metadata.action === 'prescription') {
        if (!decision.context.actorId) throw new CommunicationPolicyError('COMMUNICATION_ACTOR_REVOKED');
        const result = await queuePrescriptionCommunication({ appointmentId: appointment.id, organizationId: event.organizationId!, actorId: decision.context.actorId, clientRequestId: `completion_${appointment.id}`, communicationContext: entry.context });
        if (['pending', 'processing', 'retrying', 'accepted'].includes(result.status)) await Appointment.updateOne({ _id: appointment._id, organizationId: event.organizationId }, { $set: { rxQueuedAt: new Date() } });
        return;
      }
      const [location, doctor, org] = await Promise.all([Location.findOne({ _id: appointment.locationId, organizationId: event.organizationId }).select('name').lean(), User.findById(appointment.doctorId).select('name').lean(), Organization.findById(event.organizationId).select('whatsappConfig.notifications').lean()]);
      const time = appointment.appointmentTime.toLocaleString('en-US', { timeZone: await getLocationTimezone(String(appointment.locationId)), dateStyle: 'medium', timeStyle: 'short' });
      const state = appointment.status === 'pending_payment' ? 'awaiting payment' : appointment.status === 'pending' ? 'requested' : appointment.status === 'disruption_triage' ? 'requires staff assistance' : appointment.status;
      const text = `Your appointment at ${location?.name || 'your clinic'} ${metadata.action === 'rescheduled' ? 'was rescheduled and ' : ''}is ${state}. Scheduled time: ${time}.${metadata.action === 'refund' ? ' Its refund has been recorded as processed.' : ''} Contact reception for assistance.`;
      if (entry.channel === 'email') {
        const html = `<p>${escapeHtml(text)}</p>`;
        await enqueueTransactionalEmail({ to: decision.recipient, subject: `Appointment ${state}`, text, html, idempotencyKey: key, communicationContext: decision.context });
      } else {
        const toggle = queueAction ? (metadata.action === 'queue_delay' ? 'sendQueueDelayAlert' : 'sendTurnApproaching') : metadata.action === 'cancelled' ? 'sendAppointmentCancellation' : ['disruption', 'refund'].includes(metadata.action) ? 'sendDisruptionAlert' : 'sendBookingConfirmation';
        if ((org?.whatsappConfig?.notifications as any)?.[toggle] === false) return;
        // Never label a requested or unpaid booking as confirmed.
        const templateId = queueAction ? (metadata.action === 'queue_delay' ? 'QUEUE_DELAY_ALERT' : 'QUEUE_UPDATE') : metadata.action === 'cancelled' ? 'APPOINTMENT_CANCELLED' : appointment.status === 'confirmed' ? 'BOOKING_CONFIRMATION' : 'CRM_CONTACT_REQUEST';
        const queueVariables: Record<string, string> = {};
        if (queueAction) {
          const range = locationDayRange(locationDateKey(new Date(), zone), zone);
          const ahead = await Appointment.countDocuments({ organizationId: event.organizationId, locationId: appointment.locationId, doctorId: appointment.doctorId, appointmentTime: { $gte: range.start, $lt: range.end }, status: { $in: ['checked-in', 'confirmed'] }, queuePosition: { $lt: appointment.queuePosition ?? appointment.tokenNumber }, _id: { $ne: appointment._id } });
          queueVariables.peopleAhead = String(ahead);
          if (metadata.action === 'queue_delay') {
            if (!appointment.lastNotifiedDelayMinutes || appointment.lastNotifiedDelayMinutes <= 0) throw new CommunicationPolicyError('COMMUNICATION_SOURCE_CHANGED');
            queueVariables.delayMinutes = String(appointment.lastNotifiedDelayMinutes);
          }
          queueVariables.trackingUrl = (await issueAppointmentTrackerLink(appointment)).url;
        }
        await enqueueCommunicationTemplate({ organizationId: event.organizationId, appointmentId: appointment.id, communicationContext: decision.context, phone: decision.recipient, channel: 'whatsapp', templateId, patientName: decision.patient?.name || 'Patient', variables: { patientName: decision.patient?.name || 'Patient', locationName: location?.name || 'Your clinic', doctorName: doctor?.name || 'Doctor', appointmentTime: time, tokenNumber: String(appointment.tokenNumber), ...queueVariables }, idempotencyKey: key });
      }
    } catch (error) { if (!(error instanceof CommunicationPolicyError)) throw error; await review(entry.context, key); }
  });
}

// Both API and standalone domain worker import this module exactly once.
eventBus.subscribe('crm.appointment.communication', handleAppointmentCommunication);

import type mongoose from 'mongoose';
import type { DomainEventPayload } from '../events/types.ts';
import { Appointment } from '../models/Appointment.ts';
import { Invoice } from '../models/Invoice.ts';
import { Location } from '../models/Location.ts';
import { Patient } from '../models/Patient.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { eventBus } from '../events/eventBus.ts';
import { patientCommunicationPolicy, CommunicationPolicyError, type PatientCommunicationContext } from './PatientCommunicationPolicy.ts';
import { enqueueCommunicationTemplate, enqueueTransactionalEmail } from './CommunicationOutbox.ts';
import { createCrmTask } from './CrmTaskService.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { escapeHtml } from '../utilities/manualNotificationContent.ts';
import { getFrontendBaseUrl } from '../utilities/config.ts';
import { readEncryptedDomainEvent } from './DomainEventOutboxService.ts';
import { commandHash, CommandError } from './CommandReceiptService.ts';

export interface PaymentReceiptMessage { appointmentId: string; invoiceId: string; amount: number; paymentMethod: string; transactionId: string }
async function review(context: PatientCommunicationContext, key: string) {
  if (!await Location.exists({ _id: context.locationId, organizationId: context.organizationId, isActive: true })) return;
  const relationship = await PatientRelationship.findOne({ organizationId: context.organizationId, patientId: context.patientId, locationId: context.locationId, status: 'active' }).select('ownerId').lean();
  await createCrmTask({ organizationId: context.organizationId, locationId: context.locationId!, patientId: context.patientId, appointmentId: context.appointmentId, assignedTo: relationship?.ownerId?.toString(),
    kind: 'crm_review', title: 'Review unavailable payment receipt communication', dueDate: new Date(), dedupeKey: `receipt-review:${key}` });
}
// Runs in the payment transaction. A replay never repins a changed recipient or
// consent. The domain event is preparation work; only its child messages have
// patient delivery states and can be accepted by a provider.
export async function enqueuePaymentReceipt(message: PaymentReceiptMessage, session?: mongoose.ClientSession | null, replayOnly = false) {
  const key = `payment-receipt:${message.transactionId}`;
  const prior = await DomainEventOutbox.findOne({ idempotencyKey: key }).select('organizationId +payloadCiphertext');
  const appointment = await Appointment.findById(message.appointmentId);
  if (!appointment?.organizationId) throw new Error('Receipt appointment organization missing');
  if (prior) { if (String(prior.organizationId) !== String(appointment.organizationId) || readEncryptedDomainEvent(prior).metadata?.sourceHash !== commandHash(message)) throw new CommandError(409, 'Receipt reference was used with different payment details'); return prior; }
  const invoice = await Invoice.findOne({ _id: message.invoiceId, organizationId: appointment.organizationId, appointmentId: appointment._id, patientId: appointment.patientId, locationId: appointment.locationId }).select('currency payments status').lean();
  if (!invoice) throw new Error('Receipt invoice subject mismatch');
  const context: PatientCommunicationContext = { organizationId: String(appointment.organizationId), patientId: String(appointment.patientId), locationId: String(appointment.locationId), appointmentId: appointment.id,
    invoiceId: String(invoice._id), paymentReference: message.transactionId, paymentAmount: message.amount, paymentCurrency: invoice.currency || 'INR', paymentMethod: message.paymentMethod, purpose: 'care_operations', automated: true };
  const channels: { channel: 'whatsapp' | 'email'; context: PatientCommunicationContext }[] = [];
  for (const channel of replayOnly ? [] : ['whatsapp', 'email'] as const) {
    try { channels.push({ channel, context: (await patientCommunicationPolicy(context, channel)).context }); }
    catch (error) { if (!(error instanceof CommunicationPolicyError)) throw error; }
  }
  if (!channels.length) await review(context, key);
  const patient = await Patient.findById(appointment.patientId).select('userId').setOptions({ bypassTenantFilter: true }).lean();
  if (patient?.userId) await eventBus.publishDurable({ eventId: `${key}:inApp`, eventType: 'crm.payment.inbox', category: 'patient', organizationId: context.organizationId, targetUserId: String(patient.userId),
    title: 'Visit payment update', message: 'Open your bills to review the recorded payment.', channels: { inApp: true, email: false }, metadata: { appointmentId: appointment.id, patientId: context.patientId } }, session);
  return eventBus.publishDurable({ eventId: key, eventType: 'crm.payment.receipt', category: 'patient', organizationId: context.organizationId, metadata: { context, channels, sourceHash: commandHash(message), legacyReviewRequired: replayOnly } }, session);
}
export async function handlePaymentReceipt(event: DomainEventPayload) {
  const { context, channels } = event.metadata || {};
  if (!event.eventId || !event.organizationId || context?.organizationId !== event.organizationId || !context.invoiceId || !Array.isArray(channels)) throw new Error('Invalid receipt event');
  for (const entry of channels) await withTransaction(async () => {
    if (!['whatsapp', 'email'].includes(entry.channel) || entry.context?.organizationId !== event.organizationId || entry.context?.invoiceId !== context.invoiceId || entry.context?.paymentReference !== context.paymentReference || !entry.context?.recipientHash || !entry.context?.consentEvidenceHash) throw new Error('Invalid pinned receipt channel');
    const key = `${event.eventId}:${entry.channel}`;
    if (await OutboundMessage.exists({ idempotencyKey: key, 'payload.organizationId': event.organizationId })) return;
    try {
      const decision = await patientCommunicationPolicy(entry.context, entry.channel);
      const invoice = await Invoice.findOne({ _id: context.invoiceId, organizationId: event.organizationId }).select('invoiceNumber currency').lean();
      if (!invoice) throw new CommunicationPolicyError('COMMUNICATION_PAYMENT_SOURCE_CHANGED');
      const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: context.paymentCurrency }).format(context.paymentAmount);
      // Authenticated billing is reused. Receipt generation must not rotate the
      // patient's existing public tracker or expose a new medical capability.
      const billsUrl = `${getFrontendBaseUrl()}/dashboard/bills`;
      const text = `Payment of ${amount} was recorded for invoice ${invoice.invoiceNumber} via ${context.paymentMethod}. If you have a patient account, review your bills at ${billsUrl}. Contact reception for an invoice copy.`;
      if (entry.channel === 'email') await enqueueTransactionalEmail({ to: decision.recipient, subject: 'Visit payment recorded', text, html: `<p>${escapeHtml(text)}</p>`, idempotencyKey: key, communicationContext: decision.context });
      else await enqueueCommunicationTemplate({ organizationId: event.organizationId, appointmentId: context.appointmentId, phone: decision.recipient, patientName: decision.patient?.name || 'Patient', channel: 'whatsapp', templateId: 'BILLING_RECEIPT',
        variables: { patientName: decision.patient?.name || 'Patient', invoiceNumber: invoice.invoiceNumber, amount, paymentMethod: context.paymentMethod, trackingUrl: billsUrl, receiptUrl: billsUrl }, idempotencyKey: key, communicationContext: decision.context });
    } catch (error) { if (!(error instanceof CommunicationPolicyError)) throw error; await review(entry.context, key); }
  });
}
eventBus.subscribe('crm.payment.receipt', handlePaymentReceipt);

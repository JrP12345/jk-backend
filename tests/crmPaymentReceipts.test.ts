import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { User } from '../models/User.ts';
import { Appointment } from '../models/Appointment.ts';
import { AppointmentPayment } from '../models/AppointmentPayment.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { Invoice } from '../models/Invoice.ts';
import { Subscription } from '../models/Subscription.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { TaskModel } from '../models/Task.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { patientCommunicationFixture } from './helpers/patientCommunicationFixture.ts';
import { enqueuePaymentReceipt, handlePaymentReceipt } from '../services/PaymentReceiptEvents.ts';
import { readEncryptedDomainEvent } from '../services/DomainEventOutboxService.ts';
import { readEncryptedOutboundPayload, readCommunicationTemplate } from '../services/CommunicationOutbox.ts';
import { outboundMessageDeliveryWorker } from '../services/OutboundMessageDeliveryWorker.ts';
import { emailProvider } from '../notifications/providers/emailProvider.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { createAuthSession } from '../utilities/helpers.ts';
beforeEach(async () => { await OutboundMessage.deleteMany({}); await DomainEventOutbox.deleteMany({}); });
afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const org = await Organization.create({ name: 'Receipt clinic', city: 'London', currency: 'GBP', countryCode: 'GB', whatsappConfig: { mode: 'shared' } });
  const admin = await User.create({ name: 'Receipt manager', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create({ organizationId: org.id, userId: admin.id, role: 'admin', locationAccess: { mode: 'all' } });
  await Subscription.create({ organizationId: org.id, planId: new mongoose.Types.ObjectId(), status: 'active', currentPeriodEnd: new Date(Date.now() + 86400000), trialEndsAt: new Date(Date.now() + 86400000) });
  const f = await patientCommunicationFixture(org.id, '9876543201');
  const invoice = await Invoice.create({ organizationId: org.id, appointmentId: f.appointment.id, patientId: f.patient.id, locationId: f.branch.id, doctorId: f.appointment.doctorId,
    invoiceNumber: `TEST-${crypto.randomUUID()}`, currency: 'GBP', subtotal: 40, totalAmount: 40, amountPaid: 40, balanceDue: 0, status: 'paid',
    payments: [{ amount: 20, paymentMethod: 'cash', referenceNumber: `first_${crypto.randomUUID()}` }, { amount: 20, paymentMethod: 'cash', referenceNumber: `second_${crypto.randomUUID()}` }] });
  await Appointment.updateOne({ _id: f.appointment.id }, { paymentStatus: 'paid', invoiceId: invoice.id });
  const message = (index = 0) => ({ appointmentId: f.appointment.id, invoiceId: invoice.id, amount: 20, paymentMethod: 'cash', transactionId: invoice.payments[index].referenceNumber! });
  const enqueue = (index = 0, replayOnly = false) => withTransaction(() => enqueuePaymentReceipt(message(index), undefined, replayOnly));
  const event = async (index = 0) => { const row = await DomainEventOutbox.findOne({ idempotencyKey: `payment-receipt:${message(index).transactionId}` }).select('+payloadCiphertext'); if (!row) throw new Error('Receipt intent missing'); return readEncryptedDomainEvent(row); };
  const cookies = { access_token: (await createAuthSession({ id: admin.id, email: admin.email!, role: 'admin', organization_id: org.id })).accessToken };
  return { ...f, org, admin, invoice, message, enqueue, event, cookies };
}
it('prepares durable actual-currency receipts and creates one child per channel across replay without rotating the tracker', async () => {
  const f = await fixture(); const hash = (await Appointment.findById(f.appointment.id).select('+trackerTokenHash'))?.trackerTokenHash;
  await f.enqueue(); await f.enqueue(); const event = await f.event(); expect(event.metadata.channels).toHaveLength(2);
  expect(await OutboundMessage.countDocuments()).toBe(0);
  await handlePaymentReceipt(event); await handlePaymentReceipt(event);
  const rows = await OutboundMessage.find({ 'payload.organizationId': f.org.id }).select('+sensitivePayloadCiphertext'); expect(rows).toHaveLength(2);
  const email = readEncryptedOutboundPayload<any>(rows.find(row => row.kind === 'transactional_email')!);
  expect(email.text).toContain('£20.00'); expect(email.text).not.toContain('₹'); expect(email.text).toContain('/dashboard/bills');
  expect(email.communicationContext).toMatchObject({ invoiceId: f.invoice.id, paymentReference: f.message().transactionId, paymentAmount: 20, paymentCurrency: 'GBP' });
  expect(email.communicationContext.appointmentStatus).toBeUndefined();
  expect((await Appointment.findById(f.appointment.id).select('+trackerTokenHash'))?.trackerTokenHash).toBe(hash);
  expect(readCommunicationTemplate(rows.find(row => row.kind === 'communication_template')!).variables.amount).toBe('£20.00');
  await expect(withTransaction(() => enqueuePaymentReceipt({ ...f.message(), amount: 21 }))).rejects.toMatchObject({ statusCode: 409 });
});
it('keeps two equal partial payments distinct by their actual ledger references', async () => {
  const f = await fixture(); await f.enqueue(0); await f.enqueue(1);
  await handlePaymentReceipt(await f.event(0)); await handlePaymentReceipt(await f.event(1));
  expect(await OutboundMessage.countDocuments({ 'payload.organizationId': f.org.id })).toBe(4);
});
it('cannot repin a corrected recipient or turn an old captured payment replay into newly authorized egress', async () => {
  const f = await fixture(); await f.enqueue();
  await PatientRelationship.updateOne({ organizationId: f.org.id, patientId: f.patient.id }, { 'contact.email': 'changed@example.test', 'contact.phone': '9123456780' });
  await f.enqueue(); await handlePaymentReceipt(await f.event());
  expect(await OutboundMessage.countDocuments({ 'payload.organizationId': f.org.id })).toBe(0);
  expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_review' })).toBe(2);
  await f.enqueue(1, true); const legacy = await f.event(1); expect(legacy.metadata.channels).toEqual([]); expect(legacy.metadata.legacyReviewRequired).toBe(true);
});
it('rechecks the immutable financial source before provider dispatch and suppresses legacy unpinned fan-out work', async () => {
  const f = await fixture(), provider = vi.spyOn(emailProvider, 'sendEmail').mockResolvedValue(true);
  await f.enqueue(); await handlePaymentReceipt(await f.event());
  await Invoice.updateOne({ _id: f.invoice.id }, { status: 'refunded' });
  await outboundMessageDeliveryWorker.processBatch(2);
  const rows = await OutboundMessage.find({ 'payload.organizationId': f.org.id }); expect(rows.every(row => row.status === 'suppressed')).toBe(true); expect(provider).not.toHaveBeenCalled();
  const legacy = await OutboundMessage.create({ kind: 'payment_receipt', idempotencyKey: crypto.randomUUID(), payload: f.message(), status: 'pending', nextAttemptAt: new Date() });
  await outboundMessageDeliveryWorker.processBatch(1); expect((await OutboundMessage.findById(legacy.id))?.status).toBe('suppressed'); expect(provider).not.toHaveBeenCalled();
});
it('rolls back a counter settlement and receipt intent after outbox failure, then settles once with an attributable audit', async () => {
  const f = await fixture(); await Invoice.updateOne({ _id: f.invoice.id }, { status: 'unpaid', amountPaid: 0, balanceDue: 40, payments: [] });
  await Appointment.updateOne({ _id: f.appointment.id }, { paymentStatus: 'pending', status: 'pending_payment' });
  vi.spyOn(DomainEventOutbox, 'findOneAndUpdate').mockRejectedValueOnce(new Error('receipt outbox unavailable'));
  const request = () => app.inject({ method: 'POST', url: '/api/appointment-payments/collect-counter', cookies: f.cookies, payload: { appointmentId: f.appointment.id, paymentMethod: 'cash' } });
  expect((await request()).statusCode).toBe(500);
  expect((await Invoice.findById(f.invoice.id))?.amountPaid).toBe(0); expect((await Appointment.findById(f.appointment.id))?.paymentStatus).toBe('pending');
  expect(await AppointmentPayment.countDocuments({ appointmentId: f.appointment.id })).toBe(0);
  expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'COUNTER_PAYMENT_COLLECTED' })).toBe(0);
  const results = await Promise.all([request(), request()]); expect(results.map(row => row.statusCode).sort()).toEqual([200, 409]);
  expect((await Appointment.findById(f.appointment.id))?.status).toBe('confirmed'); expect((await Invoice.findById(f.invoice.id))?.payments).toHaveLength(1);
  expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'COUNTER_PAYMENT_COLLECTED', userId: f.admin.id })).toBe(1);
  expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id, eventType: 'crm.payment.receipt' })).toBe(1);
});

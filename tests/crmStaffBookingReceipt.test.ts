import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Patient } from '../models/Patient.ts';
import { DoctorAssignment } from '../models/DoctorAssignment.ts';
import { Appointment } from '../models/Appointment.ts';
import { Invoice } from '../models/Invoice.ts';
import { OperationReceipt } from '../models/OperationReceipt.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { hashTrackerCapability } from '../utilities/publicTracker.ts';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const org = await Organization.create({ name: 'Recorded desk clinic', city: 'Pune', plan: 'enterprise', countryCode: 'IN', currency: 'INR' });
  const branch = await Location.create({ organizationId: org.id, name: 'Desk branch', city: 'Pune', timezone: 'Asia/Kolkata' });
  const actor = await User.create({ name: 'Desk', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  const doctor = await User.create({ name: 'Clinician', role: 'doctor', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create([{ organizationId: org.id, userId: actor.id, role: 'admin', locationAccess: { mode: 'all' } }, { organizationId: org.id, userId: doctor.id, role: 'doctor' }]);
  await DoctorAssignment.create({ organizationId: org.id, locationId: branch.id, doctorId: doctor.id, fees: 350, paymentRequired: true, bookingMode: 'sequential_queue', workingHours: JSON.stringify({ all: { start: '00:00', end: '23:59' } }) });
  const patient = await Patient.create({ organizationId: org.id, name: 'Minimum registered patient' });
  await OperationReceipt.init();
  const cookies = { access_token: (await createAuthSession({ id: actor.id, email: actor.email!, role: 'admin', organization_id: org.id }, { organizationId: org.id, workspaceRole: 'admin' })).accessToken };
  const payload = { clientRequestId: crypto.randomUUID(), locationId: branch.id, doctorId: doctor.id, patientId: patient.id, appointmentTime: new Date(Date.now() + 86400000).toISOString(), appointmentType: 'reception' };
  const book = (extra = {}) => app.inject({ method: 'POST', url: '/api/appointments', cookies, payload: { ...payload, ...extra } });
  return { org, branch, actor, patient, cookies, payload, book };
}
it('records simultaneous desk retries as one visit, invoice and audit with an encrypted response', async () => {
  const f = await fixture();
  const responses = await Promise.all([f.book(), f.book()]);
  expect(responses.map(r => r.statusCode).sort(), responses.map(r => r.body).join('\n')).toEqual([200, 201]);
  const first = responses[0].json().data;
  expect(first.status).toBe('pending_payment');
  expect(responses[1].json().data.id).toBe(first.id);
  expect(responses[1].json().data.trackerToken).toBe(first.trackerToken);
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'APPOINTMENT_CREATE' })).toBe(1);
  const receipt = await OperationReceipt.findOne({ key: f.payload.clientRequestId }).select('+responseCiphertext');
  expect(receipt.responseCiphertext).not.toContain(first.trackerToken);
  expect((await f.book({ appointmentTime: new Date(Date.now() + 2 * 86400000).toISOString() })).statusCode).toBe(409);
});
it('replays current payment state and suppresses an old rotated tracker capability', async () => {
  const f = await fixture(), response = await f.book();
  expect(response.statusCode, response.body).toBe(201);
  const invoice = await Invoice.findOne({ appointmentId: response.json().data.id });
  const payment = await app.inject({ method: 'POST', url: `/api/invoices/${invoice.id}/payments`, cookies: f.cookies, headers: { 'Idempotency-Key': crypto.randomUUID() }, payload: { amount: invoice.totalAmount, paymentMethod: 'cash' } });
  expect(payment.statusCode, payment.body).toBe(200);
  await Appointment.updateOne({ _id: response.json().data.id }, { $set: { trackerTokenHash: hashTrackerCapability(crypto.randomUUID()) } });
  const replay = await f.book();
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().data).toMatchObject({ id: response.json().data.id, status: 'confirmed', paymentStatus: 'paid' });
  expect(replay.json().data.trackerToken).toBeUndefined();
  expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(1);
});
it('rolls back the visit, invoice, event and receipt when response persistence fails', async () => {
  const f = await fixture();
  vi.spyOn(OperationReceipt, 'updateOne').mockRejectedValueOnce(new Error('receipt write failed'));
  expect((await f.book()).statusCode).toBe(500);
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await OperationReceipt.countDocuments({ key: f.payload.clientRequestId })).toBe(0);
  expect((await f.book()).statusCode).toBe(201);
});
it('denies receipt recovery when the booking branch is removed from current authority', async () => {
  const f = await fixture();
  expect((await f.book()).statusCode).toBe(201);
  await OrgMember.updateOne({ organizationId: f.org.id, userId: f.actor.id }, { $set: { locationAccess: { mode: 'selected', locationIds: [] } } });
  expect([403, 404]).toContain((await f.book()).statusCode);
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
});
it('keeps the command bound to its actor after an authorized workspace role change', async () => {
  const f = await fixture(), original = await f.book();
  expect(original.statusCode).toBe(201);
  await Appointment.updateOne({ _id: original.json().data.id }, { $set: { status: 'cancelled' } });
  await OrgMember.updateOne({ organizationId: f.org.id, userId: f.actor.id }, { $set: { role: 'receptionist' } });
  const session = await createAuthSession({ id: f.actor.id, email: f.actor.email!, role: 'receptionist', organization_id: f.org.id }, { organizationId: f.org.id, workspaceRole: 'receptionist' });
  const replay = await app.inject({ method: 'POST', url: '/api/appointments', cookies: { access_token: session.accessToken }, payload: f.payload });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json().data).toMatchObject({ id: original.json().data.id, status: 'cancelled' });
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
});
it('keeps the legacy no-key booking contract and exact-time duplicate guard', async () => {
  const f = await fixture();
  const payload = { ...f.payload }; delete (payload as Partial<typeof f.payload>).clientRequestId;
  const request = () => app.inject({ method: 'POST', url: '/api/appointments', cookies: f.cookies, payload });
  expect((await request()).statusCode).toBe(201);
  expect((await request()).statusCode).toBe(409);
});

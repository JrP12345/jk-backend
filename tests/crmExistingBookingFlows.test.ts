import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { User } from '../models/User.ts';
import { Patient } from '../models/Patient.ts';
import { DoctorAssignment } from '../models/DoctorAssignment.ts';
import { Appointment } from '../models/Appointment.ts';
import { Invoice } from '../models/Invoice.ts';
import { FamilyRelationship } from '../models/FamilyRelationship.ts';
import { OperationReceipt } from '../models/OperationReceipt.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { TaskModel } from '../models/Task.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { appointmentService } from '../services/AppointmentService.ts';
afterEach(() => vi.restoreAllMocks());
async function fixture(paymentRequired = false) {
  const org = await Organization.create({ name: 'Existing booking clinic', city: 'Pune', plan: 'enterprise', countryCode: 'IN', currency: 'INR' });
  const location = await Location.create({ organizationId: org.id, name: 'Published clinic', city: 'Pune', timezone: 'Asia/Kolkata' });
  const doctor = await User.create({ name: 'Current clinician', role: 'doctor', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create({ organizationId: org.id, userId: doctor.id, role: 'doctor' });
  await DoctorAssignment.create({ organizationId: org.id, locationId: location.id, doctorId: doctor.id, bookingMode: 'sequential_queue', workingHours: JSON.stringify({ all: { start: '00:00', end: '23:59' } }), fees: 350, paymentRequired });
  const user = await User.create({ name: 'Actual patient', email: `${crypto.randomUUID()}@example.test`, role: 'patient' });
  const patient = await Patient.create({ organizationId: org.id, userId: user.id, name: user.name, accountType: 'self' });
  const cookies = { access_token: (await createAuthSession({ id: user.id, email: user.email!, role: 'patient' })).accessToken };
  const portalPayload = { clientRequestId: crypto.randomUUID(), locationId: location.id, doctorId: doctor.id, appointmentTime: new Date(Date.now() + 86400000).toISOString() };
  const qrPayload = { clientRequestId: crypto.randomUUID(), locationId: location.id, doctorId: doctor.id, name: 'Minimum walk-in', phone: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}` };
  const portal = (extra = {}) => app.inject({ method: 'POST', url: '/api/patient-portal/self-book', cookies, payload: { ...portalPayload, ...extra } });
  const qr = (extra = {}) => app.inject({ method: 'POST', url: '/api/public/join-queue', payload: { ...qrPayload, ...extra } });
  return { org, location, doctor, user, patient, cookies, portalPayload, qrPayload, portal, qr };
}
it('replays one canonical portal visit with its original protected response and actual pending state', async () => {
  const f = await fixture(true);
  const results = await Promise.all([f.portal(), f.portal()]);
  expect(results.map(row => row.statusCode).sort(), results.map(row => row.body).join('\n')).toEqual([200, 201]);
  const visit = results[0].json().data.appointment;
  expect(visit).toMatchObject({ patientId: f.patient.id, status: 'pending_payment', paymentStatus: 'pending' });
  expect(results[1].json().data.appointment.trackerToken).toBe(visit.trackerToken);
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'PATIENT_SELF_BOOKING' })).toBe(1);
  const receipt = await OperationReceipt.findOne({ key: f.portalPayload.clientRequestId }).select('+responseCiphertext');
  expect(receipt.responseCiphertext).not.toContain(visit.trackerToken);
  expect((await f.portal({ notes: 'Changed request' })).statusCode).toBe(409);
});
it('rolls back portal booking, invoice, audit, receipt and events when an attributable audit fails', async () => {
  const f = await fixture();
  const original = AuditLog.create.bind(AuditLog);
  vi.spyOn(AuditLog, 'create').mockImplementation((...args: any[]) => args[0]?.action === 'PATIENT_SELF_BOOKING' ? Promise.reject(new Error('audit unavailable')) as any : (original as any)(...args));
  expect((await f.portal()).statusCode).toBe(503);
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await OperationReceipt.countDocuments({ key: f.portalPayload.clientRequestId })).toBe(0);
});
it('retains existing family booking authority while withholding the delegated patient tracker credential', async () => {
  const f = await fixture();
  const family = await Patient.create({ organizationId: f.org.id, name: 'Family subject' });
  expect((await f.portal({ forPatientId: family.id })).statusCode).toBe(403);
  await FamilyRelationship.create({ userId: f.user.id, patientId: family.id, relationship: 'mother', status: 'active' });
  const result = await f.portal({ forPatientId: family.id });
  expect(result.statusCode, result.body).toBe(201);
  expect(result.json().data.appointment.patientId).toBe(family.id);
  expect(result.json().data.appointment).not.toHaveProperty('trackerToken');
  await FamilyRelationship.updateOne({ userId: f.user.id, patientId: family.id }, { status: 'revoked' });
  expect((await f.portal({ forPatientId: family.id })).statusCode).toBe(404);
});
it('records one minimal QR walk-in and restores the same capability without inventing a login account or birth date', async () => {
  const f = await fixture(); const users = await User.countDocuments();
  const results = await Promise.all([f.qr(), f.qr()]);
  expect(results.map(row => row.statusCode).sort(), results.map(row => row.body).join('\n')).toEqual([200, 201]);
  expect(results[0].json().data.trackingUrl).toBe(results[1].json().data.trackingUrl);
  expect(results[0].json().data.status).toBe('checked-in');
  const visit = await Appointment.findById(results[0].json().data.appointmentId);
  const patient = await Patient.findById(visit!.patientId);
  expect(patient?.dob).toBeUndefined(); expect(patient?.gender).toBeUndefined(); expect(patient?.userId).toBeUndefined();
  expect(await User.countDocuments()).toBe(users);
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await TaskModel.countDocuments({ organizationId: f.org.id, dedupeKey: `public-walkin-review:${visit!.id}` })).toBe(1);
  expect((await f.qr({ clientRequestId: crypto.randomUUID() })).statusCode).toBe(409);
});
it('requires identity review for a reused public contact and never returns another patient visit capability', async () => {
  const f = await fixture();
  await Patient.updateOne({ _id: f.patient.id }, { phone: f.qrPayload.phone });
  const result = await f.qr(); expect(result.statusCode).toBe(409);
  expect(result.json().data).toBeUndefined();
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(0);
});
it('rolls back all QR registration writes on event failure and preserves required payment on retry', async () => {
  const f = await fixture(true);
  vi.spyOn(DomainEventOutbox, 'findOneAndUpdate').mockRejectedValueOnce(new Error('event unavailable'));
  expect((await f.qr()).statusCode).toBe(503);
  expect(await Patient.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await OperationReceipt.countDocuments({ key: f.qrPayload.clientRequestId })).toBe(0);
  vi.restoreAllMocks();
  const result = await f.qr(); expect(result.statusCode, result.body).toBe(201);
  expect(result.json().data).toMatchObject({ status: 'pending_payment', paymentStatus: 'pending' });
});
it('does not permit callers to use anonymous booking authority as an ordinary actor option', async () => {
  const f = await fixture();
  await expect(appointmentService.book({ role: 'guest', bookingPatientId: f.patient.id, organizationId: f.org.id }, { locationId: f.location.id, doctorId: f.doctor.id, patientId: f.patient.id, appointmentTime: new Date().toISOString(), appointmentType: 'walk-in' }, f.org.id)).rejects.toMatchObject({ statusCode: 403 });
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(0);
});

it('returns only current own and family booking metadata and removes revoked booked-by access', async () => {
  const f = await fixture();
  const family = await Patient.create({ organizationId: f.org.id, name: 'Reviewed family subject', dob: new Date('1985-01-01'), phone: '9876543234' });
  await FamilyRelationship.create({ userId: f.user.id, patientId: family.id, relationship: 'mother', status: 'active' });
  const result = await f.portal({ forPatientId: family.id }); expect(result.statusCode).toBe(201);
  await Appointment.updateOne({ _id: result.json().data.appointment.id }, { notes: 'PRIVATE_CLINICAL_NOTE', diagnosis: 'PRIVATE_DIAGNOSIS', investigationNotes: 'PRIVATE_LAB_NOTE' });
  const history = () => app.inject({ method: 'GET', url: '/api/patient-portal/appointments?limit=1', cookies: f.cookies });
  for (const query of ['page=invalid', 'page=0', 'limit=101', 'limit=-1']) {
    expect((await app.inject({ method: 'GET', url: '/api/patient-portal/appointments?' + query, cookies: f.cookies })).statusCode).toBe(400);
  }
  const first = await history(); expect(first.statusCode).toBe(200); expect(first.json().data).toHaveLength(1);
  expect(first.body).not.toContain('PRIVATE_'); expect(first.json().data[0].patientId).not.toHaveProperty('dob'); expect(first.json().data[0]).not.toHaveProperty('trackerToken');
  await FamilyRelationship.updateOne({ userId: f.user.id, patientId: family.id }, { status: 'revoked' });
  expect((await history()).json().data).toEqual([]);
  const own = await f.portal({ clientRequestId: crypto.randomUUID() }); expect(own.statusCode).toBe(201);
  await Appointment.updateOne({ _id: own.json().data.appointment.id }, { $unset: { bookedByUserId: 1 } });
  expect((await history()).json().data[0].patientId.id).toBe(f.patient.id);
});

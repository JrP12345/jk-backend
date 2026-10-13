import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { Organization } from '../models/Organization.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { User } from '../models/User.ts';
import { Appointment } from '../models/Appointment.ts';
import { patientCommunicationFixture } from './helpers/patientCommunicationFixture.ts';
import { createTrackerCapability, issueAppointmentTrackerLink, hasValidTrackerCapability } from '../utilities/publicTracker.ts';
import { queuePrescriptionCommunication } from '../services/PrescriptionCommunicationService.ts';
import { readEncryptedOutboundPayload } from '../services/CommunicationOutbox.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { app } from '../index.ts';
async function fixture() {
  const org = await Organization.create({ name: 'Stable tracker clinic', city: 'Pune', plan: 'enterprise' });
  const admin = await User.create({ name: 'Reviewed staff', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create({ organizationId: org.id, userId: admin.id, role: 'admin' });
  const f = await patientCommunicationFixture(org.id, '9876543201');
  const capability = createTrackerCapability(), expiresAt = new Date(Date.now() + 86400000);
  await Appointment.updateOne({ _id: f.appointment.id }, { trackerTokenHash: capability.hash, trackerTokenCiphertext: capability.token, trackerTokenExpiresAt: expiresAt, status: 'completed' });
  return { ...f, org, admin, capability, expiresAt };
}
it('retains original booking and document links through authorized reissue and multiple prescription commands without extending expiry', async () => {
  const f = await fixture();
  const links = await Promise.all([1, 2, 3].map(() => issueAppointmentTrackerLink(f.appointment)));
  expect(links.every(link => link.token === f.capability.token)).toBe(true);
  const first = await queuePrescriptionCommunication({ appointmentId: f.appointment.id, organizationId: f.org.id, actorId: f.admin.id, clientRequestId: crypto.randomUUID() });
  await queuePrescriptionCommunication({ appointmentId: f.appointment.id, organizationId: f.org.id, actorId: f.admin.id, clientRequestId: crypto.randomUUID() });
  const row = await OutboundMessage.findById(first.outboxId).select('+sensitivePayloadCiphertext');
  expect(readEncryptedOutboundPayload<{ documentUrl: string }>(row!).documentUrl).toContain(encodeURIComponent(f.capability.token));
  const current = await Appointment.findById(f.appointment.id).select('+trackerTokenHash +trackerTokenCiphertext');
  expect(current!.trackerTokenExpiresAt?.getTime()).toBe(f.expiresAt.getTime());
  expect(hasValidTrackerCapability({ headers: { 'x-tracker-token': f.capability.token } } as any, current!)).toBe(true);
  expect(current!.trackerTokenCiphertext).not.toContain(f.capability.token);
  expect(current!.toJSON()).not.toHaveProperty('trackerTokenCiphertext');
  expect((await Appointment.findById(f.appointment.id))?.trackerTokenCiphertext).toBeUndefined();
});
it('renews one expired grant across concurrent reissue and keeps explicit rotation revocation effective', async () => {
  const f = await fixture(); await Appointment.updateOne({ _id: f.appointment.id }, { trackerTokenExpiresAt: new Date(Date.now() - 1000) });
  const links = await Promise.all([1, 2, 3].map(() => issueAppointmentTrackerLink(f.appointment)));
  expect(new Set(links.map(link => link.token)).size).toBe(1); expect(links[0].token).not.toBe(f.capability.token);
  const rotated = await issueAppointmentTrackerLink(f.appointment, { rotate: true });
  const current = await Appointment.findById(f.appointment.id).select('+trackerTokenHash');
  expect(hasValidTrackerCapability({ headers: { 'x-tracker-token': links[0].token } } as any, current!)).toBe(false);
  expect(hasValidTrackerCapability({ headers: { 'x-tracker-token': rotated.token } } as any, current!)).toBe(true);
});
it('withholds a draft prescription from an otherwise valid public tracker grant', async () => {
  const f = await fixture(); await Appointment.updateOne({ _id: f.appointment.id }, { status: 'in-consultation' });
  const response = await app.inject({ method: 'GET', url: `/api/public/track/${f.appointment.id}/prescription/print`, headers: { 'x-tracker-token': f.capability.token } });
  expect(response.statusCode).toBe(409);
});

it('does not disclose mismatched clinical references or print unsigned notes on a completed visit', async () => {
  const f = await fixture();
  const { Encounter } = await import('../models/Encounter.ts');
  const { ClinicalNote } = await import('../models/ClinicalNote.ts');
  const { Patient } = await import('../models/Patient.ts');
  const foreign = await Patient.create({ organizationId: f.org.id, name: 'Different subject' });
  const encounter = await Encounter.create({ organizationId: f.org.id, locationId: f.branch.id, appointmentId: f.appointment.id, patientId: foreign.id, doctorId: f.admin.id, status: 'completed' });
  const request = { method: 'GET' as const, url: '/api/public/track/' + f.appointment.id + '/prescription/print', headers: { 'x-tracker-token': f.capability.token } };
  expect((await app.inject(request)).statusCode).toBe(409);
  await Encounter.updateOne({ _id: encounter.id }, { patientId: f.patient.id });
  const note = await ClinicalNote.create({ organizationId: f.org.id, locationId: f.branch.id, encounterId: encounter.id, patientId: f.patient.id, doctorId: f.admin.id, subjective: { chiefComplaint: 'Unsigned information' }, status: 'draft' });
  expect((await app.inject(request)).statusCode).toBe(409);
  const tracker = await app.inject({ ...request, url: '/api/public/track/' + f.appointment.id });
  expect(tracker.statusCode).toBe(200); expect(tracker.json().data.consultationSummary).toBeNull();
  const { Prescription } = await import('../models/Prescription.ts');
  const foreignRx = await Prescription.create({ organizationId: f.org.id, locationId: f.branch.id, encounterId: encounter.id, patientId: foreign.id, doctorId: f.admin.id, medicineName: 'FOREIGN_MEDICINE', dosage: '10mg', frequency: 'daily', duration: '2 days' });
  await ClinicalNote.updateOne({ _id: note.id }, { status: 'signed', 'plan.prescriptionIds': [foreignRx.id] });
  await Appointment.updateOne({ _id: f.appointment.id }, { prescriptions: [{ name: 'LEGACY_UNREVIEWED_MEDICINE', dosage: '20mg', duration: '5 days' }] });
  const print = await app.inject(request); expect(print.statusCode).toBe(200);
  expect(print.body).not.toContain('FOREIGN_MEDICINE'); expect(print.body).not.toContain('LEGACY_UNREVIEWED_MEDICINE'); expect(print.body).not.toContain('1-0-1');
  expect(print.body).not.toContain('Follow prescribed meal instructions');
});

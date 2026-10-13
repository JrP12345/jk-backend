import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Patient } from '../models/Patient.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { Appointment } from '../models/Appointment.ts';
import { DPDPConsent } from '../models/DPDPConsent.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { TaskModel } from '../models/Task.ts';
import { CONSENT_NOTICE_VERSION, updatePatientConsents } from '../services/PatientConsentService.ts';
import { patientCommunicationPolicy } from '../services/PatientCommunicationPolicy.ts';

async function fixture() {
  const org = await Organization.create({ name: 'Communication clinic', city: 'Pune' });
  const branch = await Location.create({ organizationId: org.id, name: 'Communication branch', city: 'Pune' });
  const actor = await User.create({ name: 'Communication staff', email: `${crypto.randomUUID()}@example.test`, role: 'receptionist' });
  await OrgMember.create({ organizationId: org.id, userId: actor.id, role: 'receptionist', locationAccess: { mode: 'selected', locationIds: [branch.id] } });
  const patient = await Patient.create({ organizationId: org.id, name: 'Communication patient', phone: '9876543210', email: 'patient@example.test' });
  const relationship = await PatientRelationship.create({ organizationId: org.id, locationId: branch.id, patientId: patient.id });
  const context = { organizationId: org.id, locationId: branch.id, patientId: patient.id, actorId: actor.id };
  async function grant(purposes = ['COMMUNICATION_WHATSAPP'], expectedRevision = 0) {
    return updatePatientConsents(patient.id, org.id, purposes.map(purpose => ({ purpose: purpose as any, status: 'GRANTED' })), { actorId: actor.id, clientRequestId: crypto.randomUUID(), expectedRevision, method: 'in_person_confirmation', noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: true, note: 'Patient reviewed current communication choices' });
  }
  return { org, branch, actor, patient, relationship, context, grant };
}
afterEach(() => vi.restoreAllMocks());
describe('CRM communication policy', () => {
  it('keeps unknown and unevidenced legacy choices denied without writing synthetic consent', async () => {
    const f = await fixture();
    await expect(patientCommunicationPolicy(f.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_CONSENT_REQUIRED' });
    expect(await DPDPConsent.countDocuments({ organizationId: f.org.id })).toBe(0);
    await DPDPConsent.create({ organizationId: f.org.id, patientId: f.patient.id, purposes: [{ purpose: 'COMMUNICATION_WHATSAPP', status: 'GRANTED' }] });
    await expect(patientCommunicationPolicy(f.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_CONSENT_REQUIRED' });
    expect(await CrmActivity.countDocuments({ organizationId: f.org.id })).toBe(0);
  });
  it('pins canonical recipient and rechecks withdrawals or recipient corrections after enqueue', async () => {
    const f = await fixture(); await f.grant();
    const decision = await patientCommunicationPolicy(f.context, 'whatsapp', '9876543210');
    expect(decision.recipient).toBe('919876543210');
    await PatientRelationship.updateOne({ _id: f.relationship.id }, { 'contact.phone': '9876543211' });
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_RECIPIENT_CHANGED' });
    await PatientRelationship.updateOne({ _id: f.relationship.id }, { $unset: { 'contact.phone': 1 } });
    await updatePatientConsents(f.patient.id, f.org.id, [{ purpose: 'COMMUNICATION_WHATSAPP', status: 'WITHDRAWN' }], { actorId: f.actor.id, clientRequestId: crypto.randomUUID(), expectedRevision: 1, method: 'in_person_confirmation', noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: false, note: 'Patient withdrew WhatsApp messages' });
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_CONSENT_REQUIRED' });
  });
  it('requires channel and distinct follow-up or feedback purposes', async () => {
    const f = await fixture(); await f.grant();
    await expect(patientCommunicationPolicy({ ...f.context, purpose: 'care_followup' }, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_CONSENT_REQUIRED' });
    await f.grant(['PREVENTIVE_HEALTH_RECALLS', 'FEEDBACK_AND_SURVEYS', 'COMMUNICATION_EMAIL'], 1);
    expect((await patientCommunicationPolicy({ ...f.context, purpose: 'care_followup' }, 'whatsapp')).context.purpose).toBe('care_followup');
    expect((await patientCommunicationPolicy({ ...f.context, purpose: 'feedback' }, 'email')).recipient).toBe('patient@example.test');
  });
  it.each(['do_not_contact', 'invalid', 'family', 'global_opt_out'])('blocks %s without choosing a family fallback', async reason => {
    const f = await fixture(); await f.grant();
    if (reason === 'global_opt_out') await Patient.updateOne({ _id: f.patient.id }, { optOutWhatsApp: true });
    else await PatientRelationship.updateOne({ _id: f.relationship.id }, reason === 'do_not_contact' ? { 'preferences.doNotContact': true } : reason === 'invalid' ? { 'contact.availability': 'invalid' } : { 'contact.recipientType': 'family' });
    await expect(patientCommunicationPolicy(f.context, 'whatsapp')).rejects.toBeDefined();
  });
  it('rechecks live actor membership and branch grants instead of trusting a queued request', async () => {
    const f = await fixture(); await f.grant();
    const decision = await patientCommunicationPolicy(f.context, 'whatsapp');
    await OrgMember.updateOne({ userId: f.actor.id, organizationId: f.org.id }, { 'locationAccess.locationIds': [] });
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_ACTOR_REVOKED' });
    await OrgMember.deleteOne({ userId: f.actor.id, organizationId: f.org.id });
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_ACTOR_REVOKED' });
  });
  it('rejects foreign subjects, branch changes, task completion and inactive workspaces', async () => {
    const f = await fixture(); await f.grant();
    const foreign = await Organization.create({ name: 'Foreign communication clinic', city: 'Pune' });
    const appointment = await Appointment.create({ organizationId: foreign.id, locationId: f.branch.id, doctorId: f.actor.id, patientId: f.patient.id, status: 'confirmed', appointmentType: 'reception', appointmentTime: new Date(), tokenNumber: 1 });
    await expect(patientCommunicationPolicy({ ...f.context, appointmentId: appointment.id }, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_SUBJECT_UNAVAILABLE' });
    const task = await TaskModel.create({ organizationId: f.org.id, locationId: f.branch.id, patientId: f.patient.id, createdBy: f.actor.id, title: 'Callback', kind: 'crm_callback', status: 'completed' });
    await expect(patientCommunicationPolicy({ ...f.context, taskId: task.id }, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_TASK_NO_LONGER_ACTIVE' });
    await Organization.updateOne({ _id: f.org.id }, { status: 'inactive' });
    await expect(patientCommunicationPolicy(f.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_WORKSPACE_INACTIVE' });
  });
  it('suppresses queued administrative messages after a relationship branch transfer', async () => {
    const f = await fixture(); await f.grant(); const decision = await patientCommunicationPolicy(f.context, 'whatsapp');
    const branch = await Location.create({ organizationId: f.org.id, name: 'Transferred branch', city: 'Pune' });
    await PatientRelationship.updateOne({ _id: f.relationship.id }, { locationId: branch.id });
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_BRANCH_CHANGED' });
  });
  it('pins appointment state and suppresses messages after source changes', async () => {
    const f = await fixture(); await f.grant();
    const appointment = await Appointment.create({ organizationId: f.org.id, locationId: f.branch.id, patientId: f.patient.id, doctorId: f.actor.id, appointmentTime: new Date(), appointmentType: 'reception', status: 'confirmed', tokenNumber: 1 });
    const decision = await patientCommunicationPolicy({ ...f.context, appointmentId: appointment.id }, 'whatsapp');
    await Appointment.updateOne({ _id: appointment.id }, { status: 'cancelled' });
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_SOURCE_CHANGED' });
  });
  it('keeps unrelated purpose changes independent but suppresses old messages after withdrawal and regrant', async () => {
    const f = await fixture(); await f.grant(); const decision = await patientCommunicationPolicy(f.context, 'whatsapp');
    await f.grant(['COMMUNICATION_EMAIL'], 1);
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).resolves.toBeDefined();
    await updatePatientConsents(f.patient.id, f.org.id, [{ purpose: 'COMMUNICATION_WHATSAPP', status: 'WITHDRAWN' }], { actorId: f.actor.id, clientRequestId: crypto.randomUUID(), expectedRevision: 2, method: 'in_person_confirmation', noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: false, note: 'Patient withdrew channel permission' });
    await f.grant(['COMMUNICATION_WHATSAPP'], 3);
    await expect(patientCommunicationPolicy(decision.context, 'whatsapp')).rejects.toMatchObject({ reason: 'COMMUNICATION_CONSENT_CHANGED' });
  });
});

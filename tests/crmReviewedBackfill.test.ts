import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { Patient } from '../models/Patient.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Appointment } from '../models/Appointment.ts';
import { Invoice } from '../models/Invoice.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { TaskModel } from '../models/Task.ts';
import { OperationReceipt } from '../models/OperationReceipt.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { DPDPConsent } from '../models/DPDPConsent.ts';
import { applyReviewedCrmBackfill } from '../services/CrmReviewedBackfillService.ts';
afterEach(() => vi.restoreAllMocks());
it('initializes one unassigned legacy relationship with unknown contact and no inferred consent', async () => {
  const f = await fixture(), command = { ...f.command, action: 'relationship_initialize' as const };
  const before = JSON.stringify(await Appointment.findById(f.source.id).lean());
  const results = await Promise.all([applyReviewedCrmBackfill(command), applyReviewedCrmBackfill(command)]);
  expect(results[0].relationshipId).toBe(results[1].relationshipId);
  expect(await PatientRelationship.countDocuments({ organizationId: f.org.id })).toBe(1);
  const relationship = await PatientRelationship.findById(results[0].relationshipId);
  expect(relationship).toMatchObject({ contact: { availability: 'unknown', recipientType: 'patient' }, preferences: { preferredChannel: 'none' } });
  expect(relationship?.ownerId).toBeUndefined();
  expect(await DPDPConsent.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(JSON.stringify(await Appointment.findById(f.source.id).lean())).toBe(before);
  await expect(applyReviewedCrmBackfill({ ...command, clientRequestId: crypto.randomUUID() })).rejects.toMatchObject({ statusCode: 409 });
});
it('rolls back legacy relationship initialization on audit failure and refuses foreign identity inference', async () => {
  const f = await fixture(), command = { ...f.command, action: 'relationship_initialize' as const };
  const fail = vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(applyReviewedCrmBackfill(command)).rejects.toThrow('audit unavailable'); fail.mockRestore();
  expect(await PatientRelationship.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await CrmActivity.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await OperationReceipt.countDocuments({ key: command.clientRequestId })).toBe(0);
  const other = await Organization.create({ name: 'Other identity owner', city: 'Pune' });
  await Patient.updateOne({ _id: f.patient.id }, { organizationId: other.id });
  await expect(applyReviewedCrmBackfill(command)).rejects.toMatchObject({ statusCode: 409 });
});
async function fixture(legacy = true) {
  const org = await Organization.create({ name: 'Reviewed backfill clinic', city: 'Pune' });
  const branch = await Location.create({ organizationId: org.id, name: 'Reviewed branch', city: 'Pune' });
  const actor = await User.create({ name: 'Reviewed operator', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  const member = await OrgMember.create({ organizationId: org.id, userId: actor.id, role: 'admin', locationAccess: { mode: 'all' } });
  const patient = await Patient.create({ organizationId: org.id, name: 'Existing canonical patient' });
  const base = { organizationId: org.id, locationId: branch.id, patientId: patient.id, doctorId: actor.id, appointmentTime: new Date(), appointmentType: 'reception' as const };
  const child = await Appointment.create({ ...base, tokenNumber: 2, status: 'pending_payment', paymentStatus: 'pending' });
  const source = await Appointment.create({ ...base, tokenNumber: 1, status: 'completed', followUpRecommended: true, followUpTimeline: 'some time next month', ...(legacy ? { followUpAppointmentId: child.id } : {}) });
  const invoice = await Invoice.create({ organizationId: org.id, locationId: branch.id, patientId: patient.id, doctorId: actor.id, appointmentId: child.id, invoiceNumber: crypto.randomUUID(), subtotal: 350, totalAmount: 350, status: 'unpaid' });
  const command = { organizationId: org.id, actorId: actor.id, appointmentId: source.id, expectedUpdatedAt: source.updatedAt.toISOString(), action: legacy ? 'legacy_followup_review' as const : 'recommendation_review' as const, batchId: crypto.randomUUID(), clientRequestId: crypto.randomUUID() };
  return { org, branch, actor, member, patient, source, child, invoice, command };
}
it('prepares one review across concurrent exact retry without changing the linked booking or unpaid invoice', async () => {
  const f = await fixture(); const childBefore = JSON.stringify(await Appointment.findById(f.child.id).lean()), invoiceBefore = JSON.stringify(await Invoice.findById(f.invoice.id).lean());
  const results = await Promise.all([applyReviewedCrmBackfill(f.command), applyReviewedCrmBackfill(f.command)]);
  expect(results[0].taskId).toBe(results[1].taskId); expect(results.map(row => row.replayed).sort()).toEqual([false, true]);
  expect(await TaskModel.countDocuments({ organizationId: f.org.id })).toBe(1);
  expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'CRM_LEGACY_REVIEW_PREPARED' })).toBe(1);
  expect((await Appointment.findById(f.source.id))?.followUpWorkflow).toBe('review_required');
  expect(JSON.stringify(await Appointment.findById(f.child.id).lean())).toBe(childBefore);
  expect(JSON.stringify(await Invoice.findById(f.invoice.id).lean())).toBe(invoiceBefore);
});
it('retains ambiguous legacy recommendation timing as review and creates no new visit or payment', async () => {
  const f = await fixture(false); const result = await applyReviewedCrmBackfill(f.command);
  expect((await TaskModel.findById(result.taskId))?.followUpReview).toBe('ambiguous');
  expect((await Appointment.findById(f.source.id))?.followUpDueAt).toBeNull();
  expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(2);
  expect((await Invoice.findById(f.invoice.id))?.status).toBe('unpaid');
});
it('rolls back prepared review, audit, source metadata and receipt together after audit failure', async () => {
  const f = await fixture(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(applyReviewedCrmBackfill(f.command)).rejects.toThrow('audit unavailable');
  expect(await TaskModel.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect(await OperationReceipt.countDocuments({ key: f.command.clientRequestId })).toBe(0);
  expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id })).toBe(0);
  expect((await Appointment.findById(f.source.id))?.followUpTaskId).toBeUndefined();
});
it('fails closed for changed sources or lost operator authority, including replay', async () => {
  const f = await fixture();
  await Appointment.updateOne({ _id: f.source.id }, { followUpNotes: 'New clinical decision' });
  await expect(applyReviewedCrmBackfill(f.command)).rejects.toMatchObject({ statusCode: 409 });
  const current = await Appointment.findById(f.source.id); const command = { ...f.command, expectedUpdatedAt: current!.updatedAt.toISOString() };
  await applyReviewedCrmBackfill(command);
  await OrgMember.updateOne({ _id: f.member.id }, { locationAccess: { mode: 'selected', locationIds: [f.branch.id] } });
  await expect(applyReviewedCrmBackfill(command)).rejects.toMatchObject({ statusCode: 403 });
});

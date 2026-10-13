import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Patient } from '../models/Patient.ts';
import { Appointment } from '../models/Appointment.ts';
import { DoctorAssignment } from '../models/DoctorAssignment.ts';
import { TaskModel } from '../models/Task.ts';
import { Invoice } from '../models/Invoice.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";
import { OperationReceipt } from '../models/OperationReceipt.ts';
import { recommendationDueDate, recordFollowUpRecommendation, recordLegacyFollowUpReview } from '../services/CareFollowUpService.ts';
import { appointmentService } from '../services/AppointmentService.ts';
import { withClinicalTransaction } from '../utilities/transaction.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import * as notices from '../utilities/notifications.ts';
import { disruptionService } from '../services/disruptionService.ts';
import { eventBus } from '../events/eventBus.ts';
import { locationDateKey } from '../utilities/locationTime.ts';

async function fixture(paymentRequired = false) {
  const org = await Organization.create({ name: 'Care clinic', city: 'Pune', plan: 'enterprise' });
  const branch = await Location.create({ organizationId: org.id, name: 'Care branch', city: 'Pune', timezone: 'Asia/Kolkata' });
  const owner = await User.create({ name: 'Care manager', email: `${crypto.randomUUID()}@example.test`, role: 'admin' });
  const doctor = await User.create({ name: 'Care doctor', email: `${crypto.randomUUID()}@example.test`, role: 'doctor' });
  await OrgMember.create([{ organizationId: org.id, userId: owner.id, role: 'admin' }, { organizationId: org.id, userId: doctor.id, role: 'doctor' }]);
  await DoctorAssignment.create({ organizationId: org.id, locationId: branch.id, doctorId: doctor.id, workingHours: JSON.stringify({ all: { start: '00:00', end: '23:59' } }), fees: 350, paymentRequired, bookingMode: 'sequential_queue' });
  const patient = await Patient.create({ organizationId: org.id, name: 'Care patient' });
  const parent = await Appointment.create({ organizationId: org.id, locationId: branch.id, doctorId: doctor.id, patientId: patient.id, appointmentType: 'reception', appointmentTime: new Date(Date.now() - 86400000), status: 'completed', tokenNumber: 1 });
  const task = await withClinicalTransaction(() => recordFollowUpRecommendation(parent, owner.id, new Date(Date.now() + 9 * 86400000)));
  const cookies = { access_token: (await createAuthSession({ id: owner.id, email: owner.email!, role: 'admin', organization_id: org.id }, { organizationId: org.id, workspaceRole: 'admin' })).accessToken };
  const payload = { clientRequestId: crypto.randomUUID(), expectedRevision: 0, patientId: patient.id, doctorId: doctor.id, appointmentTime: new Date(Date.now() + 9 * 86400000).toISOString(), identityVerified: true };
  const convert = (extra = {}) => app.inject({ method: 'POST', url: `/api/crm/tasks/${task.id}/convert`, cookies, payload: { ...payload, ...extra } });
  return { org, branch, owner, doctor, patient, parent, task, cookies, payload, convert };
}
afterEach(() => vi.restoreAllMocks());
describe('Explicit care follow-up and recovery integrity', () => {
  it('confirms an explicit courtesy follow-up from its zero-value canonical invoice rather than leaving payment pending', async () => {
    const f = await fixture(true);
    const response = await f.convert({ appointmentTime: new Date(Date.now() + 86400000).toISOString() });
    expect(response.statusCode, response.body).toBe(201);
    const visit = response.json().data.appointment;
    expect(visit).toMatchObject({ status: 'confirmed', paymentStatus: 'not_required' });
    const appointment = await Appointment.findById(visit.id);
    expect(appointment?.paymentAmount).toBe(0);
    expect(await Invoice.findOne({ appointmentId: visit.id })).toMatchObject({ totalAmount: 0, status: 'paid', paymentMethod: 'courtesy_waiver' });
    expect((await TaskModel.findById(f.task.id))?.outcome).toBe('booking_created');
  });
  it('triages payment-pending disruption work once and rolls back when its durable task event fails', async () => {
    const f = await fixture(true), time = new Date(Date.now() + 3600000);
    await Appointment.updateOne({ _id: f.parent.id }, { status: 'pending_payment', paymentStatus: 'pending', appointmentTime: time });
    const params = { organizationId: f.org.id, locationId: f.branch.id, doctorId: f.doctor.id, userId: f.owner.id, date: locationDateKey(time, 'Asia/Kolkata'), status: 'unavailable' as const, disruptionId: f.parent._id };
    const event = vi.spyOn(eventBus, 'publishDurable').mockRejectedValueOnce(new Error('Durable task event unavailable'));
    await expect(disruptionService.processDoctorDisruption(params)).rejects.toThrow('Durable task event unavailable');
    expect((await Appointment.findById(f.parent.id))?.status).toBe('pending_payment');
    expect(await TaskModel.countDocuments({ appointmentId: f.parent.id, kind: 'crm_recovery' })).toBe(0);
    event.mockResolvedValue({} as never);
    await disruptionService.processDoctorDisruption(params); await disruptionService.processDoctorDisruption(params);
    expect((await Appointment.findById(f.parent.id))?.status).toBe('disruption_triage');
    expect(await TaskModel.countDocuments({ appointmentId: f.parent.id, kind: 'crm_recovery' })).toBe(1);
  });
  it('reschedules a disrupted unpaid booking with its canonical invoice and resolves recovery without claiming payment', async () => {
    const f = await fixture(true);
    vi.spyOn(eventBus, 'publishDurable').mockResolvedValue({} as never);
    await Appointment.updateOne({ _id: f.parent.id }, { status: 'disruption_triage', paymentStatus: 'pending', triageAction: 'pending' });
    const invoice = await Invoice.create({ organizationId: f.org.id, locationId: f.branch.id, patientId: f.patient.id, doctorId: f.doctor.id, appointmentId: f.parent.id, invoiceNumber: `CARE-${crypto.randomUUID()}`, items: [{ description: 'Consultation', amount: 350, quantity: 1 }], subtotal: 350, totalAmount: 350, balanceDue: 350, status: 'unpaid' });
    const recovery = await import('../services/CareFollowUpService.ts').then(({ recordAppointmentRecovery }) => withClinicalTransaction(() => recordAppointmentRecovery(f.parent, f.owner.id, 'disruption')));
    const result = await disruptionService.priorityReschedule({ appointmentId: f.parent.id, targetDate: locationDateKey(new Date(f.payload.appointmentTime), 'Asia/Kolkata'), rescheduledByUserId: f.owner.id });
    expect(result.newAppt.status).toBe('pending_payment');
    expect((await Invoice.findById(invoice.id))?.appointmentId?.toString()).toBe(result.newAppt.id);
    expect((await Invoice.findById(invoice.id))?.status).toBe('unpaid');
    expect((await TaskModel.findById(recovery.id))?.resultAppointmentId?.toString()).toBe(result.newAppt.id);
    expect((await TaskModel.findById(recovery.id))?.outcome).toBe('rescheduled');
  });
  it('clamps calendar months and follows branch time across DST without guessing ambiguous text', async () => {
    const f = await fixture();
    expect((await recommendationDueDate(f.branch.id, '1 month', undefined, new Date('2026-01-31T10:00:00Z')))?.toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(await recommendationDueDate(f.branch.id, 'soon')).toBeUndefined();
    expect(await recommendationDueDate(f.branch.id, '0 weeks')).toBeUndefined();
    await Location.updateOne({ _id: f.branch.id }, { timezone: 'America/New_York' });
    expect((await recommendationDueDate(f.branch.id, '1 day', undefined, new Date('2026-03-07T15:00:00Z')))?.toISOString()).toBe('2026-03-08T14:00:00.000Z');
    await expect(recommendationDueDate(f.branch.id, undefined, '2020-01-01T00:00:00Z')).rejects.toMatchObject({ statusCode: 400 });
  });
  it('restores one explicit payment-pending booking and leaves the source clinical visit completed', async () => {
    const f = await fixture(true), notice = vi.spyOn(notices, 'sendBookingNotification').mockResolvedValue();
    const first = await f.convert(); expect(first.statusCode, first.body).toBe(201);
    const second = await f.convert(); expect(second.statusCode, second.body).toBe(200);
    expect(second.json().data.appointment.id).toBe(first.json().data.appointment.id);
    expect(first.json().data.appointment).toMatchObject({ status: 'pending_payment', paymentStatus: 'pending' });
    expect(await Appointment.countDocuments({ followUpForAppointmentId: f.parent.id })).toBe(1);
    expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(1);
    expect((await Appointment.findById(f.parent.id))?.status).toBe('completed');
    expect((await Appointment.findById(first.json().data.appointment.id))?.followUpConfirmationEvidence).toBe('explicit_booking');
    expect((await TaskModel.findById(f.task.id))?.outcome).toBe('booking_pending_payment');
    expect(notice).not.toHaveBeenCalled();
    expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id, eventType: "crm.appointment.communication" })).toBeGreaterThanOrEqual(1);
  });
  it('rolls back the booking, invoice and parent link when the task cannot commit', async () => {
    const f = await fixture(); vi.spyOn(notices, 'sendBookingNotification').mockResolvedValue();
    const failure = vi.spyOn(TaskModel, 'updateOne').mockRejectedValueOnce(new Error('Task unavailable'));
    try { expect((await f.convert()).statusCode).toBe(503); } finally { failure.mockRestore(); }
    expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
    expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect((await Appointment.findById(f.parent.id))?.followUpAppointmentId).toBeUndefined();
    expect(await OperationReceipt.countDocuments({ key: f.payload.clientRequestId })).toBe(0);
    expect((await f.convert()).statusCode).toBe(201);
  });
  it('allows one winner for different concurrent booking commands', async () => {
    const f = await fixture(); vi.spyOn(notices, 'sendBookingNotification').mockResolvedValue();
    const results = await Promise.all([f.convert(), f.convert({ clientRequestId: crypto.randomUUID() })]);
    expect(results.map(row => row.statusCode).sort()).toEqual([201, 409]);
    expect(await Invoice.countDocuments({ organizationId: f.org.id })).toBe(1);
  });
  it('rejects incomplete or inaccessible source visits without completing them as a booking side effect', async () => {
    const f = await fixture();
    await Appointment.updateOne({ _id: f.parent.id }, { status: 'in-consultation' });
    expect((await f.convert()).statusCode).toBe(409);
    expect((await Appointment.findById(f.parent.id))?.status).toBe('in-consultation');
    await Appointment.updateOne({ _id: f.parent.id }, { status: 'completed' });
    const other = await Location.create({ organizationId: f.org.id, name: 'Restricted', city: 'Pune' });
    await Appointment.updateOne({ _id: f.parent.id }, { locationId: other.id });
    await OrgMember.updateOne({ userId: f.owner.id, organizationId: f.org.id }, { locationAccess: { mode: 'selected', locationIds: [f.branch.id], revision: 0 } });
    await expect(appointmentService.book({ id: f.owner.id, role: 'admin', organizationId: f.org.id }, { patientId: f.patient.id, doctorId: f.doctor.id, locationId: f.branch.id, appointmentTime: f.payload.appointmentTime, appointmentType: 'reception', followUpForAppointmentId: f.parent.id }, f.org.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
  });
  it('clarifies ambiguous recommendations using review evidence, with an exact retry and no appointment', async () => {
    const f = await fixture();
    await TaskModel.updateOne({ _id: f.task.id }, { kind: 'crm_review', followUpReview: 'ambiguous' });
    expect((await f.convert()).statusCode).toBe(409);
    const payload = { clientRequestId: crypto.randomUUID(), expectedRevision: 0, decision: 'recommendation', dueAt: f.payload.appointmentTime, identityVerified: true, reason: 'Patient reviewed clinician timing with clinic' };
    const review = () => app.inject({ method: 'POST', url: `/api/crm/tasks/${f.task.id}/review-follow-up`, cookies: f.cookies, payload });
    const first = await review(); expect(first.statusCode, first.body).toBe(200); expect((await review()).statusCode).toBe(200);
    expect((await TaskModel.findById(f.task.id))?.kind).toBe('crm_followup');
    expect((await TaskModel.findById(f.task.id))?.revision).toBe(1);
    expect(await Appointment.countDocuments({ organizationId: f.org.id })).toBe(1);
  });
  it('reviews legacy booking authority without confirming payment or silently cancelling it', async () => {
    const f = await fixture();
    const legacy = await Appointment.create({ organizationId: f.org.id, locationId: f.branch.id, doctorId: f.doctor.id, patientId: f.patient.id, appointmentType: 'reception', appointmentTime: new Date(f.payload.appointmentTime), status: 'pending_payment', paymentStatus: 'pending', tokenNumber: 2 });
    f.parent.followUpAppointmentId = legacy._id; await f.parent.save();
    const task = await withClinicalTransaction(() => recordLegacyFollowUpReview(f.parent, f.owner.id));
    const url = `/api/crm/tasks/${task.id}/review-follow-up`;
    const payload = { clientRequestId: crypto.randomUUID(), expectedRevision: 0, decision: 'confirm_existing', identityVerified: true, reason: 'Patient reviewed existing booking' };
    expect((await app.inject({ method: 'POST', url, cookies: f.cookies, payload: { ...payload, decision: 'declined' } })).statusCode).toBe(409);
    const reviewed = await app.inject({ method: 'POST', url, cookies: f.cookies, payload }); expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect((await Appointment.findById(legacy.id))?.status).toBe('pending_payment');
    expect((await Appointment.findById(legacy.id))?.followUpConfirmationEvidence).toBe('legacy_reviewed');
  });
  it('rolls back cancellation and recovery task on audit failure, then restores a repeated cancellation', async () => {
    const f = await fixture(); vi.spyOn(notices, 'sendBookingNotification').mockResolvedValue();
    await Appointment.updateOne({ _id: f.parent.id }, { status: 'confirmed' });
    const cancel = () => app.inject({ method: 'PUT', url: `/api/appointments/${f.parent.id}/cancel`, cookies: f.cookies, payload: { reason: 'Patient requested cancellation' } });
    const failure = vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('Audit unavailable'));
    try { expect((await cancel()).statusCode).toBe(500); } finally { failure.mockRestore(); }
    expect((await Appointment.findById(f.parent.id))?.status).toBe('confirmed');
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_recovery' })).toBe(0);
    const first = await cancel(); expect(first.statusCode, first.body).toBe(200); expect((await cancel()).statusCode).toBe(200);
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_recovery' })).toBe(1);
  });
});

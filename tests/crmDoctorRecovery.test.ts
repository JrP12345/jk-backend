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
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { TaskModel } from '../models/Task.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { handleDoctorAssignmentRemoval } from '../services/DoctorAssignmentRecoveryEvents.ts';
import { readEncryptedDomainEvent } from '../services/DomainEventOutboxService.ts';
import { eventBus } from '../events/eventBus.ts';

async function fixture() {
  const org = await Organization.create({ name: 'Assignment recovery', city: 'Mumbai' });
  const branch = await Location.create({ organizationId: org.id, name: 'Recovery branch', city: 'Mumbai', timezone: 'Asia/Kolkata' });
  const admin = await User.create({ name: 'Assignment manager', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  const doctor = await User.create({ name: 'Removed doctor', role: 'doctor' });
  await OrgMember.create([{ organizationId: org.id, userId: admin.id, role: 'admin' }, { organizationId: org.id, userId: doctor.id, role: 'doctor' }]);
  const patient = await Patient.create({ organizationId: org.id, name: 'Actual patient' });
  const assignment = await DoctorAssignment.create({ organizationId: org.id, locationId: branch.id, doctorId: doctor.id, workingHours: '[]' });
  const cookies = { access_token: (await createAuthSession({ id: admin.id, email: admin.email!, role: 'admin', organization_id: org.id })).accessToken };
  const remove = () => app.inject({ method: 'DELETE', url: `/api/onboarding/doctors/assignments/${assignment.id}`, cookies });
  let token = 0;
  const visit = (status: 'confirmed' | 'pending_payment' | 'completed' | 'in-consultation' = 'confirmed', extra = {}) => Appointment.create({ organizationId: org.id, locationId: branch.id, doctorId: doctor.id, patientId: patient.id, appointmentTime: new Date(Date.now() + 86400000), appointmentType: 'reception', bookingMode: 'sequential_queue', tokenNumber: ++token, status, ...extra });
  const event = async () => { const row = await DomainEventOutbox.findOne({ organizationId: org.id, eventType: 'crm.doctor.assignment.removed' }).sort({ _id: 1 }).select('+payloadCiphertext'); return readEncryptedDomainEvent(row!); };
  return { org, branch, admin, doctor, patient, assignment, remove, visit, event };
}
afterEach(() => vi.restoreAllMocks());
describe('Doctor removal produces durable scoped administrative recovery', () => {
  it('survives delayed replay once without altering payment or active consultations', async () => {
    const f = await fixture(), unpaid = await f.visit('pending_payment'), completed = await f.visit('completed'), active = await f.visit('in-consultation');
    expect((await f.remove()).statusCode).toBe(200);
    expect((await DoctorAssignment.findById(f.assignment.id))?.isActive).toBe(false);
    const event = await f.event();
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_recovery' })).toBe(0);
    await handleDoctorAssignmentRemoval(event); await handleDoctorAssignmentRemoval(event);
    const tasks = await TaskModel.find({ organizationId: f.org.id, kind: 'crm_recovery' });
    expect(tasks).toHaveLength(1); expect(String(tasks[0].appointmentId)).toBe(unpaid.id);
    expect(tasks[0].needsAssignment).toBe(true);
    expect((await Appointment.findById(unpaid.id))?.status).toBe('pending_payment');
    expect((await Appointment.findById(completed.id))?.status).toBe('completed');
    expect((await Appointment.findById(active.id))?.status).toBe('in-consultation');
    expect(eventBus.listeners(event.eventType).filter(handler => handler === handleDoctorAssignmentRemoval)).toHaveLength(1);
  });
  it('rolls removal, audit and handoff back when event persistence fails', async () => {
    const f = await fixture();
    const task = await TaskModel.create({ organizationId: f.org.id, locationId: f.branch.id, kind: 'crm_callback', title: 'Existing doctor work', assignedTo: f.doctor.id });
    vi.spyOn(DomainEventOutbox, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('outbox unavailable'); });
    expect((await f.remove()).statusCode).toBe(500);
    expect((await DoctorAssignment.findById(f.assignment.id))?.isActive).toBe(true);
    expect(String((await TaskModel.findById(task.id))?.assignedTo)).toBe(f.doctor.id);
    expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'DOCTOR_ASSIGNMENT_REMOVED' })).toBe(0);
  });
  it('ignores an obsolete removal after reassignment and excludes other branches and tenants', async () => {
    const f = await fixture(); await f.visit(); await f.remove(); const event = await f.event();
    await DoctorAssignment.updateOne({ _id: f.assignment.id }, { $set: { isActive: true }, $inc: { assignmentRevision: 1 } });
    await handleDoctorAssignmentRemoval(event);
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_recovery' })).toBe(0);
    await DoctorAssignment.updateOne({ _id: f.assignment.id }, { $set: { isActive: false, assignmentRevision: event.metadata!.assignmentRevision } });
    const otherBranch = await Location.create({ organizationId: f.org.id, name: 'Other branch', city: 'Mumbai' });
    const otherOrg = await Organization.create({ name: 'Other tenant', city: 'Mumbai' });
    await f.visit('confirmed', { locationId: otherBranch.id }); await f.visit('confirmed', { organizationId: otherOrg.id });
    await handleDoctorAssignmentRemoval(event);
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_recovery' })).toBe(1);
    expect(await TaskModel.countDocuments({ organizationId: otherOrg.id })).toBe(0);
  });
  it('denies a branch outside the manager grant before modifying the assignment', async () => {
    const f = await fixture();
    await OrgMember.updateOne({ organizationId: f.org.id, userId: f.admin.id }, { $set: { locationAccess: { mode: 'selected', locationIds: [] } } });
    expect((await f.remove()).statusCode).toBe(403);
    expect((await DoctorAssignment.findById(f.assignment.id))?.isActive).toBe(true);
  });
  it('persists a bounded continuation and resumes after an outage without duplicate tasks', async () => {
    const f = await fixture();
    await Appointment.insertMany(Array.from({ length: 101 }, (_, index) => ({ organizationId: f.org.id, locationId: f.branch.id, doctorId: f.doctor.id, patientId: f.patient.id, appointmentTime: new Date(Date.now() + 86400000), appointmentType: 'reception', tokenNumber: index + 1, status: 'confirmed', bookingMode: 'sequential_queue' })));
    await f.remove(); const first = await f.event(); await handleDoctorAssignmentRemoval(first);
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_recovery' })).toBe(100);
    const page = (await DomainEventOutbox.findOne({ organizationId: f.org.id, idempotencyKey: /^crm:assignment:page:/ }).select('+payloadCiphertext'))!;
    expect(page.status).toBe('pending'); await handleDoctorAssignmentRemoval(readEncryptedDomainEvent(page)); await handleDoctorAssignmentRemoval(first);
    expect(await TaskModel.countDocuments({ organizationId: f.org.id, kind: 'crm_recovery' })).toBe(101);
    expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id, idempotencyKey: /^crm:assignment:page:/ })).toBe(1);
  }, 60000);
});

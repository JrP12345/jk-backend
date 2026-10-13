import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../index.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Patient } from '../models/Patient.ts';
import { Subscription } from '../models/Subscription.ts';
import { Inquiry } from '../models/Inquiry.ts';
import { Appointment } from '../models/Appointment.ts';
import { TaskModel } from '../models/Task.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { createAuthSession } from '../utilities/helpers.ts';
import { canDeliverCrmTaskNotification } from '../services/CrmNotificationAuthority.ts';
import { runOrganizationCrmReminders } from '../services/CrmReminderService.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { readEncryptedDomainEvent } from '../services/DomainEventOutboxService.ts';

const clock = new Date('2026-10-09T18:30:00Z');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(clock); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture() {
  const org = await Organization.create({ name: 'Report clinic', city: 'New York', timezone: 'America/New_York' });
  const other = await Organization.create({ name: 'Foreign clinic', city: 'Mumbai' });
  const branch = await Location.create({ organizationId: org.id, name: 'Visible branch', city: 'New York', timezone: 'America/New_York' });
  const hidden = await Location.create({ organizationId: org.id, name: 'Hidden branch', city: 'Mumbai' });
  const admin = await User.create({ name: 'Report administrator', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  const membership = await OrgMember.create({ organizationId: org.id, userId: admin.id, role: 'admin', locationAccess: { mode: 'all' } });
  const patient = await Patient.create({ organizationId: org.id, name: 'Private patient name', phone: '9876543210' });
  const cookies = { access_token: (await createAuthSession({ id: admin.id, email: admin.email!, role: 'admin', organization_id: org.id })).accessToken };
  const subscription = await Subscription.create({ organizationId: org.id, planId: new mongoose.Types.ObjectId(), status: 'active', currentPeriodEnd: new Date(clock.getTime() + 86400000), trialEndsAt: new Date(clock.getTime() + 86400000) });
  let token = 0;
  const visit = (extra: Record<string, unknown> = {}) => Appointment.create({ organizationId: org.id, locationId: branch.id, doctorId: admin.id, patientId: patient.id, appointmentTime: new Date('2026-10-09T15:00:00Z'), appointmentType: 'reception', status: 'confirmed', bookingMode: 'sequential_queue', tokenNumber: ++token, ...extra });
  const inquiry = (extra = {}) => Inquiry.create({ organizationId: org.id, locationId: branch.id, createdBy: admin.id, createdAt: new Date('2026-10-09T14:00:00Z'), nextAction: { kind: 'review', dueAt: clock }, ...extra });
  const report = (query = '') => app.inject({ method: 'GET', url: `/api/crm/analytics?startDate=2026-10-09&endDate=2026-10-09&locationId=${branch.id}${query}`, cookies });
  const command = (extra = {}) => ({ clientRequestId: crypto.randomUUID(), expectedRevision: 0, automationEnabled: true, defaultInquiryHours: 4, defaultTaskHours: 12, reminderStartHour: 8, reminderEndHour: 20, feedbackRecoveryRating: 2, ...extra });
  const save = (payload: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/crm/settings', cookies, payload });
  return { org, other, branch, hidden, admin, membership, patient, cookies, subscription, visit, inquiry, report, command, save };
}
describe('Operational reports reconcile scoped cohorts and honest definitions', () => {
  it('uses branch calendar boundaries and counts only a reconciled canonical conversion', async () => {
    vi.setSystemTime(new Date('2026-10-10T04:10:00Z'));
    const f = await fixture(), booking = await f.visit(), foreign = await f.visit({ organizationId: f.other.id });
    await f.inquiry({ patientId: f.patient.id, appointmentId: booking.id, status: 'converted', source: 'phone', sourceEvidence: 'staff_reported' });
    await f.inquiry({ patientId: f.patient.id, appointmentId: foreign.id, status: 'converted' });
    await f.inquiry({ createdAt: new Date('2026-10-10T03:59:59Z') });
    await f.inquiry({ createdAt: new Date('2026-10-10T04:00:00Z') });
    await f.inquiry({ locationId: f.hidden.id }); await f.inquiry({ organizationId: f.other.id });
    const response = await f.report(); expect(response.statusCode, response.body).toBe(200);
    const report = response.json().data;
    expect(report.inquiries).toMatchObject({ total: 3, converted: 1, unreconciled: 1, active: 1, conversionPercent: 33.3 });
    expect(report.branches[0]).toMatchObject({ timezone: 'America/New_York', start: '2026-10-09T04:00:00.000Z', end: '2026-10-10T03:59:59.999Z' });
    expect(report.inquiries.sources.reduce((total: number, row: any) => total + row.total, 0)).toBe(3);
    expect(response.body).not.toContain(f.patient.name); expect(response.body).not.toContain('9876543210');
    expect(report.communications.approximateCost).toBeNull();
  });
  it('keeps current queues, attendance denominators and scoped returning history distinct', async () => {
    const f = await fixture();
    await f.visit({ status: 'completed', appointmentTime: new Date('2026-10-08T15:00:00Z') });
    await f.visit({ status: 'completed' }); await f.visit({ status: 'no-show' }); await f.visit({ status: 'cancelled' }); await f.visit({ status: 'pending_payment' });
    await TaskModel.create([{ organizationId: f.org.id, locationId: f.branch.id, kind: 'crm_callback', title: 'Due', dueDate: new Date(clock.getTime() - 1000) }, { organizationId: f.org.id, locationId: f.branch.id, kind: 'crm_followup', title: 'Snoozed', dueDate: new Date(clock.getTime() - 1000), snoozedUntil: new Date(clock.getTime() + 1000), assignedTo: f.admin.id }, { organizationId: f.org.id, locationId: f.branch.id, kind: 'crm_review', title: 'Done', status: 'completed' }]);
    await OutboundMessage.create({ kind: 'communication_template', idempotencyKey: crypto.randomUUID(), payload: { organizationId: f.org.id, locationId: f.branch.id, patientId: f.patient.id, channel: 'whatsapp' }, status: 'accepted' });
    const report = (await f.report()).json().data;
    expect(report.tasks).toMatchObject({ total: 2, overdue: 1, unassigned: 1, snoozed: 1 });
    expect(report.tasks.workload).toEqual([{ staffId: f.admin.id, name: f.admin.name, total: 1 }]);
    expect(report.appointments).toMatchObject({ total: 4, resolvedAttendance: 2, noShowPercent: 50, completedVisits: 1, returningCompletedVisits: 1 });
    expect(report.communications.states).toEqual([{ channel: 'whatsapp', status: 'accepted', total: 1 }]);
  });
  it('reports response time only from attributable outbound call reports after capture', async () => {
    const f = await fixture(), inquiry = await f.inquiry(); await f.inquiry();
    await CrmActivity.create({ organizationId: f.org.id, locationId: f.branch.id, inquiryId: inquiry.id, actorId: f.admin.id, kind: 'call_recorded', communication: { direction: 'outbound', channel: 'phone', source: 'staff_reported', occurredAt: new Date('2026-10-09T14:12:00Z') } });
    const report = (await f.report()).json().data;
    expect(report.inquiries.responseCount).toBe(1); expect(report.inquiries.averageFirstReportedCallMinutes).toBe(12);
  });
  it('denies hidden branches and oversized periods; no permission gives no report', async () => {
    const f = await fixture(); await OrgMember.updateOne({ _id: f.membership.id }, { locationAccess: { mode: 'selected', locationIds: [f.branch.id] } });
    const hidden = await app.inject({ method: 'GET', url: `/api/crm/analytics?locationId=${f.hidden.id}`, cookies: f.cookies }); expect(hidden.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/crm/analytics?startDate=2026-01-01&endDate=2026-10-09', cookies: f.cookies })).statusCode).toBe(400);
    const staff = await User.create({ name: 'Receptionist', role: 'receptionist' }); await OrgMember.create({ organizationId: f.org.id, userId: staff.id, role: 'receptionist', locationAccess: { mode: 'all' } });
    const session = await createAuthSession({ id: staff.id, email: '', role: 'receptionist', organization_id: f.org.id });
    expect((await app.inject({ method: 'GET', url: '/api/crm/analytics', cookies: { access_token: session.accessToken } })).statusCode).toBe(403);
  });
});
describe('CRM settings use explicit defaults, receipts and live entitlement', () => {
  it('keeps campaigns disabled, saves one audited revision and restores exact retries', async () => {
    const f = await fixture(); const initial = await app.inject({ method: 'GET', url: '/api/crm/settings', cookies: f.cookies });
    expect(initial.json().data).toMatchObject({ automationEnabled: false, campaignsEnabled: false, defaultInquiryHours: 1, defaultTaskHours: 24 });
    const command = f.command(), first = await f.save(command), retry = await f.save(command);
    expect(first.statusCode, first.body).toBe(200); expect(retry.json().data).toMatchObject({ revision: 1, replayed: true, campaignsEnabled: false });
    expect(await AuditLog.countDocuments({ organizationId: f.org.id, action: 'CRM_SETTINGS_CHANGED' })).toBe(1);
    expect((await f.save({ ...command, defaultTaskHours: 13 })).statusCode).toBe(409);
    expect((await f.save(f.command({ campaignsEnabled: true }))).statusCode).toBe(400);
  });
  it('rolls settings and receipt back after audit failure, then permits the same retry', async () => {
    const f = await fixture(), command = f.command(); vi.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('settings audit unavailable'));
    expect((await f.save(command)).statusCode).toBe(503);
    expect((await Organization.findById(f.org.id))?.crmSettings?.automationEnabled).toBe(false);
    expect((await f.save(command)).statusCode).toBe(200);
  });
  it('requires organization-wide authority, rejects invalid hours and preserves expired read access', async () => {
    const f = await fixture();
    expect((await f.save(f.command({ reminderStartHour: 20, reminderEndHour: 8 }))).statusCode).toBe(400);
    await Subscription.updateOne({ _id: f.subscription.id }, { currentPeriodEnd: new Date(clock.getTime() - 1) });
    expect((await f.save(f.command())).statusCode).toBe(409);
    expect((await f.save(f.command({ automationEnabled: false }))).statusCode).toBe(200);
    await OrgMember.updateOne({ _id: f.membership.id }, { locationAccess: { mode: 'selected', locationIds: [f.branch.id] } });
    expect((await f.save(f.command({ expectedRevision: 1, automationEnabled: false }))).statusCode).toBe(403);
    await Subscription.deleteOne({ _id: f.subscription.id });
    const read = await app.inject({ method: 'GET', url: '/api/crm/settings', cookies: f.cookies }); expect(read.statusCode).toBe(200); expect(read.json().data.entitlementActive).toBe(false);
    expect(await Subscription.countDocuments({ organizationId: f.org.id })).toBe(0);
  });
  it('serializes competing settings updates and enforces branch-local reminder windows', async () => {
    const f = await fixture(); const results = await Promise.all([f.save(f.command()), f.save(f.command({ defaultInquiryHours: 5 }))]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 409]);
    const task = await TaskModel.create({ organizationId: f.org.id, locationId: f.branch.id, assignedTo: f.admin.id, kind: 'crm_callback', title: 'Reminder', dueDate: clock });
    await runOrganizationCrmReminders(f.org.id, 'settings-test');
    const row = (await DomainEventOutbox.findOne({ organizationId: f.org.id, eventType: 'crm.task.due' }).select('+payloadCiphertext'))!;
    const event = readEncryptedDomainEvent(row); expect(await canDeliverCrmTaskNotification(event)).toBe(true);
    await Organization.updateOne({ _id: f.org.id }, { 'crmSettings.reminderStartHour': 16, 'crmSettings.revision': 2 });
    expect(await canDeliverCrmTaskNotification(event)).toBe(false);
    expect((await runOrganizationCrmReminders(f.org.id, 'settings-test')).processed).toBe(0);
    vi.setSystemTime(new Date('2026-10-09T21:00:00Z'));
    expect((await runOrganizationCrmReminders(f.org.id, 'settings-test')).processed).toBe(1);
    expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id, eventType: 'crm.task.due' })).toBe(2);
    expect((await TaskModel.findById(task.id))?.status).toBe('todo');
  });
});

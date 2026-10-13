import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { Subscription } from '../models/Subscription.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { User } from '../models/User.ts';
import { TaskModel } from '../models/Task.ts';
import { Notification } from '../models/Notification.ts';
import { NotificationPreference } from '../models/NotificationPreference.ts';
import { DomainEventOutbox } from '../models/DomainEventOutbox.ts';
import { WorkerLease } from '../models/WorkerLease.ts';
import { runOrganizationCrmReminders } from '../services/CrmReminderService.ts';
import { publishCrmTaskEvent } from '../services/CrmTaskService.ts';
import { readEncryptedDomainEvent } from '../services/DomainEventOutboxService.ts';
import { domainEventDeliveryWorker } from '../services/DomainEventDeliveryWorker.ts';
import { notificationQueue } from '../notifications/services/NotificationQueue.ts';
import '../notifications/services/NotificationService.ts';
async function fixture(enabled = true) {
  const org = await Organization.create({ name: 'Reminder clinic', city: 'Pune', crmSettings: { automationEnabled: enabled, reminderStartHour: 0, reminderEndHour: 24 } });
  const branch = await Location.create({ organizationId: org.id, name: 'Reminder branch', city: 'Pune', timezone: 'America/New_York' });
  const actor = await User.create({ name: 'Current manager', role: 'admin', email: `${crypto.randomUUID()}@example.test` });
  await OrgMember.create({ organizationId: org.id, userId: actor.id, role: 'admin' });
  const subscription = await Subscription.create({ organizationId: org.id, planId: new mongoose.Types.ObjectId(), status: 'active', currentPeriodEnd: new Date(Date.now() + 86400000), trialEndsAt: new Date(Date.now() + 86400000) });
  const task = await TaskModel.create({ organizationId: org.id, locationId: branch.id, kind: 'crm_callback', title: 'Administrative reminder', assignedTo: actor.id, createdBy: actor.id, dueDate: new Date(Date.now() - 60000), revision: 0 });
  return { org, branch, actor, subscription, task, sweep: (holder = 'test-holder', cursor?: string, limit?: number) => runOrganizationCrmReminders(org.id, holder, cursor, limit) };
}
beforeEach(async () => { await DomainEventOutbox.deleteMany({}); await WorkerLease.deleteMany({}); });
afterEach(() => vi.restoreAllMocks());
describe('Scoped durable CRM reminders and delivery authority', () => {
  it('defaults automation off and never provisions missing entitlements', async () => {
    const f = await fixture(false); expect((await f.sweep()).processed).toBe(0);
    await Organization.updateOne({ _id: f.org.id }, { 'crmSettings.automationEnabled': true });
    await Subscription.deleteOne({ _id: f.subscription.id });
    expect((await f.sweep()).processed).toBe(0); expect(await Subscription.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect(await DomainEventOutbox.countDocuments()).toBe(0);
  });
  it('deduplicates daily reminders in the branch timezone and leaves another tenant untouched', async () => {
    const f = await fixture(), other = await fixture();
    await f.sweep(); await f.sweep();
    const rows = await DomainEventOutbox.find({ organizationId: f.org.id }).select('+payloadCiphertext');
    expect(rows).toHaveLength(1); expect(await DomainEventOutbox.countDocuments({ organizationId: other.org.id })).toBe(0);
    const event = readEncryptedDomainEvent(rows[0]);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    expect(event.metadata.localDate).toBe(day); expect(event.metadata).not.toHaveProperty('patientId');
    expect((await TaskModel.findById(f.task.id))?.revision).toBe(0);
  });
  it('respects snooze, active branch and account authority without changing assignments', async () => {
    const f = await fixture();
    await TaskModel.updateOne({ _id: f.task.id }, { snoozedUntil: new Date(Date.now() + 60000) });
    expect((await f.sweep()).processed).toBe(0);
    await TaskModel.updateOne({ _id: f.task.id }, { $unset: { snoozedUntil: 1 } });
    await Location.updateOne({ _id: f.branch.id }, { isActive: false }); expect((await f.sweep()).processed).toBe(0);
    await Location.updateOne({ _id: f.branch.id }, { isActive: true });
    await User.updateOne({ _id: f.actor.id }, { isActive: false }); expect((await f.sweep()).processed).toBe(0);
    expect(String((await TaskModel.findById(f.task.id))?.assignedTo)).toBe(f.actor.id);
  });
  it('bounds pages and lets later work progress without duplicate events after restart', async () => {
    const f = await fixture();
    await TaskModel.create({ organizationId: f.org.id, locationId: f.branch.id, kind: 'crm_review', title: 'Second reminder', assignedTo: f.actor.id, dueDate: new Date(Date.now() - 1000) });
    const first = await f.sweep('test-holder', undefined, 1); expect(first.nextCursor).toBe(f.task.id);
    await f.sweep('test-holder', first.nextCursor!, 1); await f.sweep();
    expect(await DomainEventOutbox.countDocuments({ organizationId: f.org.id })).toBe(2);
  });
  it('fences another holder and rolls event writes back after persistence failure', async () => {
    const f = await fixture();
    await WorkerLease.create({ name: `crm-reminders:${f.org.id}`, holderId: 'other-holder', expiresAt: new Date(Date.now() + 60000) });
    expect((await f.sweep()).processed).toBe(0);
    await WorkerLease.deleteMany({});
    vi.spyOn(DomainEventOutbox, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('outbox unavailable'); });
    await expect(f.sweep()).rejects.toThrow('outbox unavailable'); expect(await DomainEventOutbox.countDocuments()).toBe(0);
    await f.sweep(); expect(await DomainEventOutbox.countDocuments()).toBe(1);
  });
  it.each(['assignment', 'revision', 'membership', 'expiry', 'disabled', 'branch'])('suppresses a delayed reminder after %s changes', async change => {
    const f = await fixture(); await f.sweep();
    if (change === 'assignment') await TaskModel.updateOne({ _id: f.task.id }, { $unset: { assignedTo: 1 } });
    if (change === 'revision') await TaskModel.updateOne({ _id: f.task.id }, { $inc: { revision: 1 } });
    if (change === 'membership') await OrgMember.deleteOne({ organizationId: f.org.id, userId: f.actor.id });
    if (change === 'expiry') await Subscription.updateOne({ _id: f.subscription.id }, { currentPeriodEnd: new Date(Date.now() - 1000) });
    if (change === 'disabled') await Organization.updateOne({ _id: f.org.id }, { 'crmSettings.automationEnabled': false });
    if (change === 'branch') await Location.updateOne({ _id: f.branch.id }, { isActive: false });
    await domainEventDeliveryWorker.processOne();
    expect(await Notification.countDocuments({ organizationId: f.org.id })).toBe(0);
    expect((await DomainEventOutbox.findOne({ organizationId: f.org.id }))?.status).toBe('sent');
  });
  it('repairs inbox persistence on replay and never routes CRM reminders to email', async () => {
    const f = await fixture();
    await NotificationPreference.create({ userId: f.actor.id, organizationId: f.org.id, channels: { email: true, inApp: true } });
    await publishCrmTaskEvent(f.task, f.actor.id);
    const email = vi.spyOn(notificationQueue, 'enqueue');
    vi.spyOn(Notification, 'findOneAndUpdate').mockImplementationOnce(() => { throw new Error('inbox outage'); });
    await domainEventDeliveryWorker.processOne();
    const row = (await DomainEventOutbox.findOne({ organizationId: f.org.id }))!; expect(row.status).toBe('retrying');
    await DomainEventOutbox.updateOne({ _id: row.id }, { nextAttemptAt: new Date(0) });
    await domainEventDeliveryWorker.processOne();
    expect(await Notification.countDocuments({ organizationId: f.org.id })).toBe(1); expect(email).not.toHaveBeenCalled();
  });
});

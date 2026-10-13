import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { crmEntitlementActive } from './CrmEntitlementService.ts';
import { TaskModel } from '../models/Task.ts';
import { WorkerLease } from '../models/WorkerLease.ts';
import { validateCrmAssignee } from './CrmAssignmentService.ts';
import { CRM_TASK_KINDS } from './CrmTaskService.ts';
import { eventBus } from '../events/eventBus.ts';
import { acquireOrRenewWorkerLease } from '../utilities/workerLease.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { locationDateKey, locationClockMinutes, getLocationTimezone } from '../utilities/locationTime.ts';

// Scheduler writes only generic staff reminder events for an explicitly enabled
// organization. It never contacts patients, changes assignments or deletes data.
export async function crmRemindersEnabled(organizationId: string, now = new Date()) {
  const [org, entitled] = await Promise.all([
    Organization.findOne({ _id: organizationId, isActive: true, status: 'active', 'crmSettings.automationEnabled': true }).select('_id').lean(),
    crmEntitlementActive(organizationId, now),
  ]);
  return !!org && entitled;
}
export async function crmReminderWindow(organizationId: string, locationId: string, now = new Date()) {
  const org = await Organization.findById(organizationId).select('crmSettings').lean();
  const timezone = await getLocationTimezone(locationId), minutes = locationClockMinutes(now, timezone);
  return { allowed: minutes >= (org?.crmSettings?.reminderStartHour ?? 8) * 60 && minutes < (org?.crmSettings?.reminderEndHour ?? 20) * 60,
    revision: org?.crmSettings?.revision || 0, localDate: locationDateKey(now, timezone) };
}
export async function runOrganizationCrmReminders(organizationId: string, holderId: string, cursor?: string, limit = 100) {
  const name = `crm-reminders:${organizationId}`;
  if (!await crmRemindersEnabled(organizationId) || !await acquireOrRenewWorkerLease({ name, holderId, leaseMs: 120_000 })) return { processed: 0, nextCursor: cursor || null };
  const pageSize = Math.min(100, Math.max(1, Math.floor(limit)));
  const rows = await TaskModel.find({ organizationId, kind: { $in: CRM_TASK_KINDS }, status: { $ne: 'completed' }, dueDate: { $lte: new Date() }, assignedTo: { $exists: true }, ...(cursor ? { _id: { $gt: cursor } } : {}) }).sort({ _id: 1 }).select('_id').limit(pageSize).lean();
  let processed = 0;
  for (const row of rows) await withTransaction(async () => {
    // A transaction writes this lease before the event. A takeover causes a
    // conflict/rollback; a stale worker cannot commit a reminder after lease loss.
    const fence = await WorkerLease.updateOne({ name, holderId, expiresAt: { $gt: new Date() } }, { $inc: { fenceRevision: 1 }, $set: { expiresAt: new Date(Date.now() + 120_000) } });
    if (fence.matchedCount !== 1) throw new Error('CRM reminder lease lost');
    if (!await crmRemindersEnabled(organizationId)) return;
    const task = await TaskModel.findOne({ _id: row._id, organizationId, kind: { $in: CRM_TASK_KINDS }, status: { $ne: 'completed' }, dueDate: { $lte: new Date() } });
    if (!task?.assignedTo || (task.snoozedUntil && task.snoozedUntil > new Date()) || !await Location.exists({ _id: task.locationId, organizationId, isActive: true })) return;
    try { await validateCrmAssignee(String(task.assignedTo), organizationId, String(task.locationId), 'MANAGE_CRM_TASKS'); }
    catch (error: any) { if (error.statusCode === 400) return; throw error; }
    const window = await crmReminderWindow(organizationId, String(task.locationId));
    if (!window.allowed) return;
    await eventBus.publishDurable({ eventId: `crm:task:due:${task.id}:${task.revision || 0}:${window.localDate}:${window.revision}`, eventType: 'crm.task.due', category: 'task', organizationId, targetUserId: String(task.assignedTo), title: 'Patient relationship task due', message: 'Review the current task in your authorized workspace.', actionUrl: `/dashboard/crm/tasks?taskId=${task.id}`, channels: { inApp: true, email: false, sms: false, push: false }, metadata: { taskId: task.id, taskRevision: task.revision || 0, locationId: String(task.locationId), localDate: window.localDate, settingsRevision: window.revision } });
    processed++;
  });
  return { processed, nextCursor: rows.length === pageSize ? String(rows[rows.length - 1]._id) : null };
}

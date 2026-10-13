import type { DomainEventPayload } from '../events/types.ts';
import { TaskModel } from '../models/Task.ts';
import { Location } from '../models/Location.ts';
import { Organization } from '../models/Organization.ts';
import { validateCrmAssignee } from './CrmAssignmentService.ts';
import { crmRemindersEnabled, crmReminderWindow } from './CrmReminderService.ts';

export function isCrmTaskNotification(event: DomainEventPayload) {
  return ['crm.task.changed', 'crm.task.due'].includes(event.eventType);
}
// Delayed events cannot restore an old assignment or branch authorization.
export async function canDeliverCrmTaskNotification(event: DomainEventPayload) {
  if (!event.organizationId || !event.targetUserId || !event.metadata?.taskId) return false;
  const task = await TaskModel.findOne({ _id: event.metadata.taskId, organizationId: event.organizationId, assignedTo: event.targetUserId, kind: /^crm_/, status: { $ne: 'completed' } }).lean();
  if (!task || String(task.locationId) !== event.metadata.locationId) return false;
  const revision = event.metadata.taskRevision;
  if (!Number.isInteger(revision) || revision !== task.revision) return false;
  if (event.eventType === 'crm.task.due' && (!task.dueDate || task.dueDate > new Date() || (task.snoozedUntil && task.snoozedUntil > new Date()))) return false;
  if (event.eventType === 'crm.task.due') {
    if (!await crmRemindersEnabled(event.organizationId)) return false;
    const window = await crmReminderWindow(event.organizationId, String(task.locationId));
    if (!window.allowed || event.metadata.localDate !== window.localDate || event.metadata.settingsRevision !== window.revision) return false;
  }
  if (!await Organization.exists({ _id: event.organizationId, isActive: true, status: 'active' }) || !await Location.exists({ _id: task.locationId, organizationId: event.organizationId, isActive: true })) return false;
  try { await validateCrmAssignee(event.targetUserId, event.organizationId, String(task.locationId), 'MANAGE_CRM_TASKS'); }
  catch (error: any) { if (error.statusCode === 400) return false; throw error; }
  return true;
}

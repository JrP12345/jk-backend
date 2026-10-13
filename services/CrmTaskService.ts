import { TaskModel } from '../models/Task.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { eventBus } from '../events/eventBus.ts';
import { validateCrmAssignee } from './CrmAssignmentService.ts';

export const CRM_TASK_KINDS = ['crm_callback', 'crm_review', 'crm_inquiry', 'crm_followup', 'crm_recovery', 'crm_feedback', 'crm_diagnostic'];
export function crmTaskDTO(task: any) {
  const ref = (value: any) => value?._id?.toString() || value?.toString() || null;
  return { id: ref(task._id), title: task.title, kind: task.kind, status: task.status, priority: task.priority,
    locationId: ref(task.locationId), patientId: ref(task.patientId), inquiryId: ref(task.inquiryId), appointmentId: ref(task.appointmentId),
    resultAppointmentId: ref(task.resultAppointmentId), orderId: ref(task.orderId),
    followUpReview: task.followUpReview || null,
    assignedTo: ref(task.assignedTo), assigneeName: task.assignedTo?.name || '', dueDate: task.dueDate, snoozedUntil: task.snoozedUntil,
    revision: task.revision || 0, outcome: task.outcome || null, needsAssignment: task.needsAssignment === true, createdAt: task.createdAt };
}
export async function publishCrmTaskEvent(task: any, actorId?: string) {
  await eventBus.publishDurable({ eventId: `crm:task:${task.id}:${task.revision || 0}`, eventType: 'crm.task.changed', category: 'task',
    organizationId: String(task.organizationId), createdBy: actorId, targetUserId: task.assignedTo?.toString(),
    title: 'Patient relationship task updated', message: 'Review the current task in your authorized workspace.', actionUrl: `/dashboard/crm/tasks?taskId=${task.id}`,
    channels: { email: false, sms: false, push: false, inApp: true }, metadata: { taskId: task.id, taskRevision: task.revision || 0, locationId: String(task.locationId) } });
}
// Called inside the inquiry command transaction, so there is exactly one current
// next-action Task rather than a second queue or separate CRMTask collection.
export async function syncInquiryTask(inquiry: any, actorId: string, reactivate = false) {
  const organizationId = String(inquiry.organizationId), locationId = String(inquiry.locationId);
  let ownerId = inquiry.ownerId?.toString(), needsAssignment = !ownerId;
  if (ownerId) {
    try { await validateCrmAssignee(ownerId, organizationId, locationId, 'MANAGE_CRM_TASKS'); }
    catch (error: any) { if (error.statusCode !== 400) throw error; ownerId = undefined; needsAssignment = true; }
  }
  const completed = ['closed', 'converted'].includes(inquiry.status);
  const existing = await TaskModel.findOne({ organizationId, dedupeKey: `inquiry:${inquiry.id}:next` });
  const status = completed ? 'completed' : !existing || reactivate ? 'todo' : existing.status;
  const fields = { organizationId, locationId, patientId: inquiry.patientId, inquiryId: inquiry._id, kind: 'crm_inquiry',
    title: inquiry.nextAction.kind === 'contact' ? 'Contact inquiry caller' : inquiry.nextAction.kind === 'book' ? 'Arrange inquiry booking' : 'Review inquiry',
    dueDate: inquiry.nextAction.dueAt, sourceRevision: inquiry.revision, status, needsAssignment,
    ...(ownerId ? { assignedTo: ownerId } : {}), ...(completed ? { completedAt: new Date(), outcome: inquiry.status === 'converted' ? 'converted' : 'inquiry_closed' } : {}) };
  const task = await TaskModel.findOneAndUpdate({ organizationId, dedupeKey: `inquiry:${inquiry.id}:next` }, {
    $set: fields, $setOnInsert: { createdBy: actorId, dedupeKey: `inquiry:${inquiry.id}:next` },
    $inc: { revision: existing ? 1 : 0 },
    ...(!ownerId || (!completed && reactivate) ? { $unset: { ...(!ownerId ? { assignedTo: 1 } : {}), ...(!completed && reactivate ? { completedAt: 1, outcome: 1, snoozedUntil: 1 } : {}) } } : {}),
  }, { upsert: true, returnDocument: 'after', runValidators: true });
  await publishCrmTaskEvent(task, actorId);
  return task;
}
export async function createCrmTask(input: { organizationId: string; locationId: string; patientId?: string; inquiryId?: string; appointmentId?: string; orderId?: string; actorId?: string; kind: string; title: string; dueDate: Date; assignedTo?: string; dedupeKey: string; followUpReview?: 'ambiguous' | 'legacy' }) {
  let ownerId = input.assignedTo;
  if (ownerId) {
    try { await validateCrmAssignee(ownerId, input.organizationId, input.locationId, 'MANAGE_CRM_TASKS'); }
    catch (error: any) { if (error.statusCode !== 400) throw error; ownerId = undefined; }
  }
  const task = await TaskModel.findOneAndUpdate({ organizationId: input.organizationId, dedupeKey: input.dedupeKey }, { $setOnInsert: {
    organizationId: input.organizationId, locationId: input.locationId, patientId: input.patientId, inquiryId: input.inquiryId, appointmentId: input.appointmentId,
    orderId: input.orderId, createdBy: input.actorId, kind: input.kind, title: input.title, dueDate: input.dueDate, assignedTo: ownerId, needsAssignment: !ownerId, dedupeKey: input.dedupeKey, revision: 0,
    followUpReview: input.followUpReview,
  } }, { upsert: true, returnDocument: 'after', runValidators: true });
  await CrmActivity.updateOne({ organizationId: input.organizationId, eventKey: `task-created:${task.id}` }, { $setOnInsert: {
    organizationId: input.organizationId, locationId: input.locationId, patientId: input.patientId, inquiryId: input.inquiryId, appointmentId: input.appointmentId,
    taskId: task._id, actorId: input.actorId, kind: 'task_created', eventKey: `task-created:${task.id}`,
  } }, { upsert: true, runValidators: true });
  await publishCrmTaskEvent(task, input.actorId);
  return task;
}

import { Location } from '../models/Location.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { createCrmTask, publishCrmTaskEvent } from './CrmTaskService.ts';
import { TaskModel } from '../models/Task.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
export async function recordCommunicationRecovery(message: any) {
  const context = message.payload;
  if (!context.organizationId || !context.locationId || !context.patientId) return;
  // No new clinical inference, cross-branch owner fallback or automatic resend.
  if (!await Location.exists({ _id: context.locationId, organizationId: context.organizationId, isActive: true })) return;
  const relationship = await PatientRelationship.findOne({ organizationId: context.organizationId, patientId: context.patientId, locationId: context.locationId, status: 'active' }).select('ownerId');
  await createCrmTask({ organizationId: context.organizationId, locationId: context.locationId, patientId: context.patientId, appointmentId: context.appointmentId, actorId: context.actorId, kind: 'crm_review', title: 'Review unavailable patient communication', dueDate: new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `communication-recovery:${message.id}` });
}
export async function resolveCommunicationRecovery(message: any) {
  const context = message.payload;
  if (!context.organizationId) return;
  const task = await TaskModel.findOneAndUpdate({ organizationId: context.organizationId, dedupeKey: `communication-recovery:${message.id}`, status: { $ne: 'completed' } }, { $set: { status: 'completed', completedAt: new Date(), outcome: 'message_delivery_confirmed' }, $inc: { revision: 1 }, $unset: { snoozedUntil: 1 } }, { returnDocument: 'after' });
  if (!task) return;
  await CrmActivity.create({ organizationId: context.organizationId, locationId: task.locationId, patientId: task.patientId, taskId: task._id, kind: 'communication_recovery_resolved', outcome: 'message_delivery_confirmed', communication: { channel: 'whatsapp', direction: 'outbound', source: 'provider_event', occurredAt: new Date() } });
  await publishCrmTaskEvent(task);
}

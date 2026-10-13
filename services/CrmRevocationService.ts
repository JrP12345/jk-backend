import { TaskModel } from '../models/Task.ts';
import { Inquiry } from '../models/Inquiry.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { CRM_TASK_KINDS } from './CrmTaskService.ts';
// Must share the membership-change transaction. Historical completed work remains
// attributable; unfinished work moves to the scoped unassigned queue.
export async function unassignRevokedCrmWork(organizationId: string, userId: string, retainedLocationIds?: string[]) {
  const scope = { organizationId, ...(retainedLocationIds ? { locationId: { $nin: retainedLocationIds } } : {}) };
  const inquiries = await Inquiry.updateMany({ ...scope, ownerId: userId, status: { $in: ['open', 'in_progress'] } }, { $unset: { ownerId: 1 }, $inc: { revision: 1 } });
  const inquiryTasks = await TaskModel.updateMany({ ...scope, assignedTo: userId, kind: 'crm_inquiry', status: { $ne: 'completed' } }, { $unset: { assignedTo: 1 }, $set: { needsAssignment: true }, $inc: { revision: 1, sourceRevision: 1 } });
  const tasks = await TaskModel.updateMany({ ...scope, assignedTo: userId, kind: { $in: CRM_TASK_KINDS.filter(kind => kind !== 'crm_inquiry') }, status: { $ne: 'completed' } }, { $unset: { assignedTo: 1 }, $set: { needsAssignment: true }, $inc: { revision: 1 } });
  const relationships = await PatientRelationship.updateMany({ ...scope, ownerId: userId, status: 'active' }, { $unset: { ownerId: 1 }, $inc: { revision: 1 } });
  return { inquiries: inquiries.modifiedCount, tasks: tasks.modifiedCount + inquiryTasks.modifiedCount, relationships: relationships.modifiedCount };
}

// Called only by an explicitly scoped role/staff command in its transaction.
// A permission change hands off only the work that the affected member lost.
export async function handoffCrmPermissionLoss(organizationId: string, userId: string, permissions: Set<string>) {
  if (!permissions.has('VIEW_CRM')) return unassignRevokedCrmWork(organizationId, userId);
  let inquiries = 0, tasks = 0;
  if (!permissions.has('MANAGE_CRM_INQUIRIES')) {
    const owned = await Inquiry.find({ organizationId, ownerId: userId, status: { $in: ['open', 'in_progress'] } }).select('_id revision').limit(1001).lean();
    if (owned.length > 1000) throw new Error('This permission handoff requires a staged organization review');
    for (const inquiry of owned) {
      await Inquiry.updateOne({ _id: inquiry._id, organizationId, ownerId: userId, revision: inquiry.revision }, { $unset: { ownerId: 1 }, $inc: { revision: 1 } });
      const changed = await TaskModel.updateMany({ organizationId, inquiryId: inquiry._id, kind: 'crm_inquiry', status: { $ne: 'completed' } }, { $unset: { assignedTo: 1 }, $set: { needsAssignment: true, sourceRevision: (inquiry.revision || 0) + 1 }, $inc: { revision: 1 } });
      inquiries++; tasks += changed.modifiedCount;
    }
  }
  if (!permissions.has('MANAGE_CRM_TASKS')) {
    const changed = await TaskModel.updateMany({ organizationId, assignedTo: userId, kind: { $in: CRM_TASK_KINDS }, status: { $ne: 'completed' } }, { $unset: { assignedTo: 1 }, $set: { needsAssignment: true }, $inc: { revision: 1 } });
    tasks += changed.modifiedCount;
  }
  return { inquiries, tasks, relationships: 0 };
}

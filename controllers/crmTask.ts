import type { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { TaskModel } from '../models/Task.ts';
import { Inquiry } from '../models/Inquiry.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { crmAuthority, crmPatientAuthority } from '../services/CrmAuthorityService.ts';
import { validateCrmAssignee } from '../services/CrmAssignmentService.ts';
import { createCrmTask, crmTaskDTO, CRM_TASK_KINDS, publishCrmTaskEvent } from '../services/CrmTaskService.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { checkLocationAccess } from '../utilities/tenant.ts';
import { requestHasAnyPermission } from '../utilities/permissions.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';
function filter(authority: Awaited<ReturnType<typeof crmAuthority>>) { return { organizationId: authority.organizationId, kind: { $in: CRM_TASK_KINDS }, ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }) }; }
function failure(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
  req.log.error({ err: error }, 'CRM task workflow failed');
  return reply.code(503).send(errorResponse('The task result could not be confirmed. Retry the same request.'));
}
export async function listCrmTasks(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), query = req.query as any, scoped: any = filter(authority);
    if (query.locationId) { const branch = await checkLocationAccess(req, query.locationId, { requireExplicitScope: true }); if (!branch.allowed || branch.organizationId !== authority.organizationId) throw new CommandError(404, 'Branch not available'); scoped.locationId = query.locationId; }
    if (query.owner === 'mine' || !query.owner) scoped.assignedTo = authority.actorId;
    else if (query.owner === 'unassigned') scoped.assignedTo = null;
    else if (query.owner !== 'team') throw new CommandError(400, 'Invalid task ownership filter');
    if (query.status === 'completed') scoped.status = 'completed';
    else if (query.status !== 'all') scoped.status = { $ne: 'completed' };
    const now = new Date();
    if (query.due === 'due') { scoped.dueDate = { $lte: now }; scoped.$or = [{ snoozedUntil: { $exists: false } }, { snoozedUntil: null }, { snoozedUntil: { $lte: now } }]; }
    else if (query.due === 'snoozed') scoped.snoozedUntil = { $gt: now };
    if (query.cursor) { if (!mongoose.isValidObjectId(query.cursor)) throw new CommandError(400, 'Invalid task cursor'); scoped._id = { $lt: query.cursor }; }
    if (query.kind) { if (!CRM_TASK_KINDS.includes(query.kind)) throw new CommandError(400, 'Invalid task kind'); scoped.kind = query.kind; }
    const rows = await TaskModel.find(scoped).populate('assignedTo', 'name').sort({ _id: -1 }).limit(21).maxTimeMS(5000).lean();
    return reply.send(successResponse({ items: rows.slice(0, 20).map(crmTaskDTO), nextCursor: rows.length > 20 ? String(rows[19]._id) : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function getCrmTask(req: FastifyRequest, reply: FastifyReply) {
  try {
    const authority = await crmAuthority(req), taskId = (req.params as { id: string }).id;
    const task = await TaskModel.findOne({ _id: taskId, ...filter(authority) }).populate('assignedTo', 'name').lean();
    if (!task) throw new CommandError(404, 'Task not found in your scope');
    const cursor = (req.query as { activityCursor?: string }).activityCursor;
    if (cursor && !mongoose.isValidObjectId(cursor)) throw new CommandError(400, 'Invalid activity cursor');
    const activities = await CrmActivity.find({ organizationId: authority.organizationId, locationId: task.locationId, taskId, visibility: 'administrative', ...(cursor ? { _id: { $lt: cursor } } : {}) }).select('+note kind outcome actorId createdAt').populate('actorId', 'name').sort({ _id: -1 }).limit(21);
    return reply.send(successResponse({ ...crmTaskDTO(task), activities: activities.slice(0, 20).map(row => ({ id: row.id, kind: row.kind, outcome: row.outcome, note: row.get('note'), actorName: (row.actorId as any)?.name || 'System', createdAt: row.createdAt })), nextActivityCursor: activities.length > 20 ? activities[19].id : null }));
  } catch (error) { return failure(req, reply, error); }
}
export async function captureCrmTask(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before creating a task');
    const authority = await crmAuthority(req), input = req.body as any;
    const result = await executeRecordedCommand(`crm-task-create:${authority.organizationId}:${authority.actorId}`, input.clientRequestId, input, async () => {
      const branch = await checkLocationAccess(req, input.locationId, { requireExplicitScope: true });
      if (!branch.allowed || branch.organizationId !== authority.organizationId) throw new CommandError(404, 'Branch not available');
      if (input.patientId) await crmPatientAuthority(req, input.patientId);
      if (input.inquiryId || input.appointmentId) throw new CommandError(400, 'Use the inquiry or appointment workflow for linked tasks');
      const owner = input.assignedTo === undefined ? req.user?.role === 'root' ? null : authority.actorId : input.assignedTo;
      if (owner !== authority.actorId && !await requestHasAnyPermission(req, 'ASSIGN_CRM_TASKS')) throw new CommandError(403, 'Assignment permission required');
      if (owner) await validateCrmAssignee(owner, authority.organizationId, input.locationId, 'MANAGE_CRM_TASKS');
      const task = await createCrmTask({ organizationId: authority.organizationId, locationId: input.locationId, patientId: input.patientId, actorId: authority.actorId,
        assignedTo: owner || undefined, kind: input.kind, title: input.kind === 'crm_callback' ? 'Patient callback' : 'Administrative patient review', dueDate: new Date(input.dueDate), dedupeKey: `manual:${authority.actorId}:${input.clientRequestId}` });
      if (input.note?.trim()) await CrmActivity.create({ organizationId: authority.organizationId, locationId: input.locationId, patientId: input.patientId, taskId: task._id, actorId: authority.actorId, kind: 'task_instruction_recorded', note: input.note.trim() });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: 'CRM_TASK_CREATED', targetId: task._id, targetModel: 'Task', category: 'ADMIN', details: { kind: input.kind, locationId: input.locationId } });
      return task.id;
    });
    const task = await TaskModel.findOne({ _id: result.resultId, ...filter(authority) }).populate('assignedTo', 'name').lean();
    if (!task) throw new CommandError(404, 'The task is no longer in your scope');
    return reply.code(result.replayed ? 200 : 201).send(successResponse(crmTaskDTO(task)));
  } catch (error) { return failure(req, reply, error); }
}
export async function updateCrmTask(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before changing a task');
    const authority = await crmAuthority(req), taskId = (req.params as { id: string }).id, input = req.body as any;
    await executeRecordedCommand(`crm-task-update:${authority.organizationId}:${authority.actorId}:${taskId}`, input.clientRequestId, input, async () => {
      const task = await TaskModel.findOne({ _id: taskId, ...filter(authority) });
      if (!task) throw new CommandError(404, 'Task not found in your scope');
      const branch = await checkLocationAccess(req, String(task.locationId), { requireExplicitScope: true });
      if (!branch.allowed || branch.organizationId !== authority.organizationId) throw new CommandError(409, 'This task branch is unavailable. An authorized administrator must review the handoff.');
      if ((task.revision || 0) !== input.expectedRevision) throw new CommandError(409, 'Task changed. Reload before saving.');
      const manager = await requestHasAnyPermission(req, 'ASSIGN_CRM_TASKS');
      const owns = task.assignedTo?.toString() === authority.actorId;
      if (!owns && !manager && !(input.action === 'assign' && !task.assignedTo && input.assignedTo === authority.actorId)) throw new CommandError(403, 'Only the owner or an authorized manager may change this task');
      const changes: any = {}, unset: any = {};
      if (input.action === 'assign') {
        if (input.assignedTo === undefined) throw new CommandError(400, 'Choose an assignee or explicitly unassign the task');
        if (!input.reason?.trim()) throw new CommandError(400, 'Record an assignment reason');
        if (!manager && (task.assignedTo || input.assignedTo !== authority.actorId)) throw new CommandError(403, 'Assignment permission required');
        if (input.assignedTo) { await validateCrmAssignee(input.assignedTo, authority.organizationId, String(task.locationId), 'MANAGE_CRM_TASKS'); changes.assignedTo = input.assignedTo; changes.needsAssignment = false; }
        else { unset.assignedTo = 1; changes.needsAssignment = true; }
      } else if (input.action === 'snooze') {
        if (task.status === 'completed' || !input.reason?.trim()) throw new CommandError(400, 'Choose an unfinished task and record a snooze reason');
        const due = new Date(input.snoozedUntil);
        if (!Number.isFinite(due.getTime()) || due <= new Date() || due.getTime() > Date.now() + 365 * 86400000) throw new CommandError(400, 'Choose a future snooze time within one year');
        changes.snoozedUntil = due; changes.dueDate = due;
      } else if (input.action === 'start') {
        if (task.status === 'completed') throw new CommandError(409, 'Reopen a completed task before starting it');
        changes.status = 'in_progress'; unset.snoozedUntil = 1;
      } else if (input.action === 'reopen') {
        if (!input.reason?.trim() || !input.dueDate || task.status !== 'completed') throw new CommandError(400, 'Choose a completed task, new due time and reason');
        if (task.kind === 'crm_inquiry') throw new CommandError(409, 'Reopen the inquiry to schedule its next action');
        changes.status = 'todo'; changes.dueDate = new Date(input.dueDate); unset.completedAt = 1; unset.outcome = 1; unset.snoozedUntil = 1;
      } else if (input.action === 'complete') {
        if (task.followUpReview) throw new CommandError(409, 'Use the care follow-up review to resolve uncertain timing or legacy booking authority');
        if (task.status === 'completed') throw new CommandError(409, 'This task is already completed');
        if (!input.outcome || (input.outcome === 'other' && !input.reason?.trim())) throw new CommandError(400, 'Choose an outcome and explain other outcomes');
        changes.status = 'completed'; changes.outcome = input.outcome; changes.completedAt = new Date(); unset.snoozedUntil = 1;
      }
      if (task.inquiryId) {
        const inquiry = await Inquiry.findOne({ _id: task.inquiryId, organizationId: authority.organizationId, locationId: task.locationId });
        if (!inquiry || inquiry.revision !== task.sourceRevision || ['closed', 'converted'].includes(inquiry.status)) throw new CommandError(409, 'The linked inquiry changed. Reload its current next action.');
        const inquiryChanges: any = {};
        if (input.action === 'assign') { if (input.assignedTo) inquiryChanges.ownerId = input.assignedTo; }
        if (input.action === 'snooze') inquiryChanges.nextAction = { kind: inquiry.nextAction.kind, dueAt: changes.dueDate };
        if (input.action === 'complete') {
          if (input.closeInquiry) {
            if (!await requestHasAnyPermission(req, 'MANAGE_CRM_INQUIRIES')) throw new CommandError(403, 'Inquiry management permission is required to close it');
            if (!input.closeReason || input.closeReason === 'duplicate_inquiry') throw new CommandError(400, 'Choose a close outcome; duplicate review belongs in the inquiry workflow');
            if (input.closeReason === 'other' && !input.reason?.trim()) throw new CommandError(400, 'Record the other close reason');
            inquiryChanges.status = 'closed'; inquiryChanges.closedAt = new Date(); inquiryChanges.closeReason = input.closeReason;
          } else {
            if (!input.nextAction) throw new CommandError(400, 'Schedule the next inquiry action or explicitly close the inquiry');
            inquiryChanges.nextAction = { kind: input.nextAction.kind, dueAt: new Date(input.nextAction.dueAt) };
            changes.status = 'todo'; changes.dueDate = inquiryChanges.nextAction.dueAt;
            changes.title = input.nextAction.kind === 'contact' ? 'Contact inquiry caller' : input.nextAction.kind === 'book' ? 'Arrange inquiry booking' : 'Review inquiry';
            unset.completedAt = 1; delete changes.completedAt;
          }
        }
        const changed = await Inquiry.updateOne({ _id: inquiry._id, organizationId: authority.organizationId, revision: inquiry.revision }, { $set: inquiryChanges, ...(input.action === 'assign' && !input.assignedTo ? { $unset: { ownerId: 1 } } : {}), $inc: { revision: 1 } });
        if (changed.modifiedCount !== 1) throw new CommandError(409, 'The linked inquiry changed');
        changes.sourceRevision = inquiry.revision + 1;
      }
      const changed = await TaskModel.updateOne({ _id: task._id, organizationId: authority.organizationId, revision: input.expectedRevision }, { $set: changes, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { revision: 1 } }, { runValidators: true });
      if (changed.modifiedCount !== 1) throw new CommandError(409, 'Task changed. Reload before saving.');
      await CrmActivity.create({ organizationId: authority.organizationId, locationId: task.locationId, patientId: task.patientId, inquiryId: task.inquiryId, appointmentId: task.appointmentId, taskId: task._id,
        actorId: authority.actorId, kind: `task_${input.action}`, outcome: input.outcome, note: input.reason?.trim(), revision: input.expectedRevision + 1 });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: 'CRM_TASK_UPDATED', targetId: task._id, targetModel: 'Task', category: 'ADMIN', details: { action: input.action, outcome: input.outcome, assignedTo: input.assignedTo, revision: input.expectedRevision + 1 } });
      await publishCrmTaskEvent(await TaskModel.findOne({ _id: task._id, organizationId: authority.organizationId }), authority.actorId);
      return taskId;
    });
    return getCrmTask(req, reply);
  } catch (error) { return failure(req, reply, error); }
}

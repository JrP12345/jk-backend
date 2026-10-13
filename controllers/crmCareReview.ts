import type { FastifyRequest, FastifyReply } from 'fastify';
import { TaskModel } from '../models/Task.ts';
import { Appointment } from '../models/Appointment.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { crmAuthority } from '../services/CrmAuthorityService.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { recommendationDueDate } from '../services/CareFollowUpService.ts';
import { AppointmentDomainError } from '../services/AppointmentService.ts';
import { crmTaskDTO, publishCrmTaskEvent } from '../services/CrmTaskService.ts';
import { requestHasAnyPermission } from '../utilities/permissions.ts';
import { errorResponse, successResponse } from '../utilities/helpers.ts';

export async function reviewCareFollowUp(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before reviewing follow-up');
    const authority = await crmAuthority(req), id = (req.params as { id: string }).id, input = req.body as any;
    if (!input.reason?.trim() || input.identityVerified !== true) throw new CommandError(400, 'Record the reviewed patient authority and timing or booking evidence');
    const scope = { _id: id, organizationId: authority.organizationId, ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }) };
    const result = await executeRecordedCommand(`crm-care-review:${authority.organizationId}:${authority.actorId}:${id}`, input.clientRequestId, input, async () => {
      const task = await TaskModel.findOne(scope);
      if (!task?.followUpReview || !task.appointmentId) throw new CommandError(404, 'Follow-up review task not found');
      if (task.revision !== input.expectedRevision || task.status === 'completed') throw new CommandError(409, 'Review task changed. Reload before saving');
      if (task.assignedTo?.toString() !== authority.actorId && !await requestHasAnyPermission(req, 'ASSIGN_CRM_TASKS')) throw new CommandError(403, 'Only the task owner or authorized manager may review');
      const parent = await Appointment.findOne({ _id: task.appointmentId, organizationId: authority.organizationId, locationId: task.locationId, patientId: task.patientId, status: 'completed' });
      if (!parent) throw new CommandError(409, 'The completed source visit requires clinical review');
      let dueDate: Date | undefined, childId: string | undefined;
      if (input.decision === 'confirm_existing') {
        if (task.followUpReview !== 'legacy') throw new CommandError(400, 'There is no legacy booking to confirm');
        const child = await Appointment.findOne({ _id: parent.followUpAppointmentId, organizationId: authority.organizationId, patientId: task.patientId, locationId: task.locationId, status: { $in: ['pending', 'pending_payment', 'confirmed', 'checked-in'] } });
        if (!child || child.followUpConfirmationEvidence) throw new CommandError(409, 'The legacy booking changed or already has evidence');
        const changed = await Appointment.updateOne({ _id: child._id, organizationId: authority.organizationId, status: child.status, followUpConfirmationEvidence: { $exists: false } }, { $set: { followUpForAppointmentId: parent._id, followUpConfirmationEvidence: 'legacy_reviewed' } });
        if (changed.modifiedCount !== 1) throw new CommandError(409, 'Legacy booking changed during review');
        childId = child.id;
        await Appointment.updateOne({ _id: parent._id, organizationId: authority.organizationId }, { $set: { followUpWorkflow: 'booked' } });
      } else {
        if (task.followUpReview === 'legacy' && await Appointment.exists({ _id: parent.followUpAppointmentId, organizationId: authority.organizationId, status: { $nin: ['cancelled', 'no-show', 'completed'] } })) throw new CommandError(409, 'Review or explicitly cancel the existing booking through the appointment workflow first');
        if (input.decision === 'recommendation') {
          if (!input.dueAt) throw new CommandError(400, 'Choose the clarified recommendation date');
          dueDate = await recommendationDueDate(String(task.locationId), undefined, input.dueAt);
        }
        await Appointment.updateOne({ _id: parent._id, organizationId: authority.organizationId }, { $set: { followUpWorkflow: dueDate ? 'recommended' : 'declined', ...(dueDate ? { followUpDueAt: dueDate, followUpTaskId: task._id } : {}) } });
      }
      const changed = await TaskModel.updateOne({ ...scope, revision: input.expectedRevision }, { $set: { status: dueDate ? 'todo' : 'completed', kind: dueDate ? 'crm_followup' : 'crm_review', title: dueDate ? 'Arrange recommended care follow-up' : task.title, outcome: dueDate ? 'timing_clarified' : childId ? 'legacy_booking_reviewed' : 'declined', ...(dueDate ? { dueDate } : { completedAt: new Date() }), ...(childId ? { resultAppointmentId: childId } : {}) }, $unset: { followUpReview: 1, snoozedUntil: 1 }, $inc: { revision: 1 } });
      if (changed.modifiedCount !== 1) throw new CommandError(409, 'Review task changed while saving');
      await CrmActivity.create({ organizationId: authority.organizationId, locationId: task.locationId, patientId: task.patientId, taskId: task._id, appointmentId: parent._id, actorId: authority.actorId, kind: 'care_followup_reviewed', outcome: input.decision, note: input.reason.trim(), revision: input.expectedRevision + 1 });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: 'CRM_CARE_FOLLOWUP_REVIEWED', targetId: task._id, targetModel: 'Task', category: 'ADMIN', details: { decision: input.decision, childId, dueDate } });
      await publishCrmTaskEvent(await TaskModel.findOne(scope), authority.actorId);
      return task.id;
    });
    const task = await TaskModel.findOne(scope);
    if (!task) throw new CommandError(404, 'Task is no longer in your scope');
    return reply.send(successResponse({ ...crmTaskDTO(task), replayed: result.replayed }, 'Follow-up review saved or restored'));
  } catch (error: any) {
    if (error instanceof CommandError || error instanceof AppointmentDomainError) return reply.code(error.statusCode).send(errorResponse(error.message));
    req.log.error({ err: error }, 'Care follow-up review failed');
    return reply.code(503).send(errorResponse('The review result could not be confirmed. Retry the same command.'));
  }
}

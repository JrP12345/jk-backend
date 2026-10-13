import type { FastifyRequest, FastifyReply } from 'fastify';
import { TaskModel } from '../models/Task.ts';
import { Appointment } from '../models/Appointment.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { crmPatientAuthority, crmAuthority } from '../services/CrmAuthorityService.ts';
import { CommandError, executeRecordedCommand } from '../services/CommandReceiptService.ts';
import { CRM_TASK_KINDS, publishCrmTaskEvent } from '../services/CrmTaskService.ts';
import { appointmentService, AppointmentDomainError } from '../services/AppointmentService.ts';
import { requestHasAnyPermission } from '../utilities/permissions.ts';
import { successResponse, errorResponse } from '../utilities/helpers.ts';
export async function convertPatientTask(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (req.user?.impersonatedBy) throw new CommandError(403, 'End impersonation before arranging a booking');
    const authority = await crmAuthority(req), input = req.body as any, id = (req.params as { id: string }).id;
    if (input.identityVerified !== true || input.patientDetails) throw new CommandError(400, 'Select the task patient and confirm identity and booking authority');
    let effects: (() => Promise<void>)[] = [];
    const result = await executeRecordedCommand(`crm-task-booking:${authority.organizationId}:${authority.actorId}:${id}`, input.clientRequestId, input, async () => {
      effects = [];
      const task = await TaskModel.findOne({ _id: id, organizationId: authority.organizationId, kind: { $in: CRM_TASK_KINDS }, ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }) });
      if (!task || !task.patientId) throw new CommandError(404, 'An authorized canonical patient task is required');
      if (task.kind === 'crm_inquiry') throw new CommandError(409, 'Convert the linked inquiry through its own workflow');
      if (task.followUpReview) throw new CommandError(409, 'Review the uncertain follow-up timing or legacy booking before creating a booking');
      if ((task.revision || 0) !== input.expectedRevision || task.status === 'completed') throw new CommandError(409, 'Task changed or already completed. Reload its booking before retrying.');
      if (task.assignedTo?.toString() !== authority.actorId && !await requestHasAnyPermission(req, 'ASSIGN_CRM_TASKS')) throw new CommandError(403, 'Only the task owner or an authorized manager may book');
      if (input.patientId !== String(task.patientId)) throw new CommandError(400, 'The booking patient must match the task patient');
      await crmPatientAuthority(req, input.patientId);
      const source = task.kind === 'crm_followup' ? await Appointment.findOne({ _id: task.appointmentId, organizationId: authority.organizationId, patientId: task.patientId, locationId: task.locationId, status: 'completed' }) : null;
      if (task.kind === 'crm_followup' && !source) throw new CommandError(409, 'The completed source visit requires review before arranging follow-up');
      const booking = await appointmentService.book({ id: authority.actorId, role: req.user!.role, organizationId: authority.organizationId },
        { patientId: input.patientId, doctorId: input.doctorId, locationId: String(task.locationId), appointmentTime: input.appointmentTime, appointmentType: 'reception',
          reasonForVisit: source ? 'follow_up' : 'new_consultation', followUpForAppointmentId: source?.id, lockId: input.lockId, payAtLocation: input.payAtLocation }, authority.organizationId, { deferAfterCommit: effect => effects.push(effect) });
      const changed = await TaskModel.updateOne({ _id: task._id, organizationId: authority.organizationId, revision: input.expectedRevision, status: { $ne: 'completed' } },
        { $set: { status: 'completed', completedAt: new Date(), outcome: booking.status === 'pending_payment' ? 'booking_pending_payment' : 'booking_created', resultAppointmentId: booking.id }, $unset: { snoozedUntil: 1 }, $inc: { revision: 1 } });
      if (changed.modifiedCount !== 1) throw new CommandError(409, 'Task changed while arranging the booking');
      await CrmActivity.create({ organizationId: authority.organizationId, locationId: task.locationId, patientId: task.patientId, taskId: task._id, appointmentId: booking.id, actorId: authority.actorId, kind: 'task_booking_arranged', outcome: booking.status, revision: input.expectedRevision + 1 });
      await AuditLog.create({ organizationId: authority.organizationId, userId: authority.actorId, action: 'CRM_TASK_BOOKING_ARRANGED', targetId: task._id, targetModel: 'Task', category: 'ADMIN', details: { appointmentId: booking.id, sourceAppointmentId: source?.id, status: booking.status } });
      await publishCrmTaskEvent(await TaskModel.findOne({ _id: task._id, organizationId: authority.organizationId }), authority.actorId);
      return booking.id;
    });
    const task = await TaskModel.findOne({ _id: id, organizationId: authority.organizationId, ...(authority.allLocations ? {} : { locationId: { $in: authority.locationIds } }) }).select('locationId');
    if (!task) throw new CommandError(404, 'The task is no longer in your scope');
    if (!result.replayed) await Promise.allSettled(effects.map(effect => effect()));
    const appointment = await Appointment.findOne({ _id: result.resultId, organizationId: authority.organizationId, locationId: task.locationId }).select('status paymentStatus tokenNumber').lean();
    if (!appointment) throw new CommandError(409, 'The recorded booking requires review; do not create another booking');
    return reply.code(result.replayed ? 200 : 201).send(successResponse({ appointment: { id: String(appointment._id), status: appointment.status, paymentStatus: appointment.paymentStatus, tokenNumber: appointment.tokenNumber }, replayed: result.replayed }, appointment.status === 'pending_payment' ? 'Booking recorded; payment remains pending' : 'Task booking recorded or restored'));
  } catch (error: any) {
    if (error instanceof CommandError || error instanceof AppointmentDomainError) return reply.code(error.statusCode).send(errorResponse(error.message));
    if (error?.code === 11000) return reply.code(409).send(errorResponse('Booking slot or task changed. Reload before retrying.'));
    req.log.error({ err: error }, 'Patient task conversion failed');
    return reply.code(503).send(errorResponse('The booking result could not be confirmed. Retry the same submitted command.'));
  }
}

import { LabOrder } from '../models/LabOrder.ts';
import { Location } from '../models/Location.ts';
import { getOrganizationPatient } from './PatientRecordAccessService.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { Encounter } from '../models/Encounter.ts';
import { Appointment } from '../models/Appointment.ts';
import { TaskModel } from '../models/Task.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { createCrmTask, publishCrmTaskEvent } from './CrmTaskService.ts';
import { eventBus } from '../events/eventBus.ts';

/** Administrative references only. Results and clinical escalation stay in the lab workflow. Call inside the clinical transaction. */
export async function syncDiagnosticHandoff(orderId: string, actorId?: string) {
  const order = await LabOrder.findById(orderId).select('organizationId locationId patientId appointmentId encounterId status deletedAt').lean();
  if (!order || order.deletedAt) throw new Error('Diagnostic source unavailable');
  const branch = await Location.findById(order.locationId).select('organizationId').lean();
  if (!branch || (order.organizationId && String(order.organizationId) !== String(branch.organizationId))) throw new Error('Diagnostic source organization mismatch');
  const organizationId = String(branch.organizationId), locationId = String(order.locationId), patientId = String(order.patientId);
  const patient = await getOrganizationPatient(patientId, organizationId);
  if (!patient) throw new Error('Diagnostic patient organization mismatch');
  let appointmentId = order.appointmentId?.toString();
  if (order.encounterId) {
    const encounter = await Encounter.findOne({ _id: order.encounterId, organizationId, locationId, patientId }).select('appointmentId').lean();
    if (!encounter || (appointmentId && encounter.appointmentId && appointmentId !== String(encounter.appointmentId))) throw new Error('Diagnostic encounter mismatch');
    appointmentId ||= encounter.appointmentId?.toString();
  }
  if (appointmentId && !await Appointment.exists({ _id: appointmentId, organizationId, locationId, patientId })) throw new Error('Diagnostic visit mismatch');
  const relationship = await PatientRelationship.findOne({ organizationId, patientId, locationId, status: 'active' }).select('ownerId').lean();
  const terminal = ['result-uploaded', 'cancelled'].includes(order.status);
  const waitingKey = `diagnostic:${orderId}:waiting`;
  if (terminal) {
    const task = await TaskModel.findOneAndUpdate({ organizationId, dedupeKey: waitingKey, status: { $ne: 'completed' } }, { $set: { status: 'completed', completedAt: new Date(), outcome: order.status === 'cancelled' ? 'source_cancelled' : 'source_result_ready' }, $inc: { revision: 1 }, $unset: { snoozedUntil: 1 } }, { returnDocument: 'after' });
    if (task) await publishCrmTaskEvent(task, actorId);
  } else {
    await createCrmTask({ organizationId, locationId, patientId, appointmentId, orderId, actorId, kind: 'crm_diagnostic', title: 'Coordinate diagnostic order handoff', dueDate: new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: waitingKey });
  }
  if (order.status === 'result-uploaded') await createCrmTask({ organizationId, locationId, patientId, appointmentId, orderId, actorId, kind: 'crm_diagnostic', title: 'Coordinate diagnostic follow-through with clinical staff', dueDate: new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `diagnostic:${orderId}:ready` });
  const eventKey = `diagnostic:${orderId}:${order.status}`;
  await CrmActivity.updateOne({ organizationId, eventKey }, { $setOnInsert: { organizationId, locationId, patientId, appointmentId, actorId, kind: 'diagnostic_handoff', outcome: order.status, eventKey } }, { upsert: true });
  if (patient.userId) await eventBus.publishDurable({ eventId: `${eventKey}:inApp`, eventType: 'crm.diagnostic.inbox', organizationId, category: 'labs', targetUserId: String((patient.userId as any)._id || patient.userId), createdBy: actorId,
    title: 'Diagnostic order update', message: 'Open your diagnostic orders to review their current state.', channels: { inApp: true, email: false, sms: false, push: false }, metadata: { orderId, patientId, locationId, context: { orderStatus: order.status } } });
}

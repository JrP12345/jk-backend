import type { DomainEventPayload } from '../events/types.ts';
import { eventBus } from '../events/eventBus.ts';
import { DoctorAssignment } from '../models/DoctorAssignment.ts';
import { Appointment } from '../models/Appointment.ts';
import { Location } from '../models/Location.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { createCrmTask } from './CrmTaskService.ts';
import { withTransaction } from '../utilities/transaction.ts';
import { getLocationTimezone, locationDateKey, locationDayRange } from '../utilities/locationTime.ts';
import { CommandError } from './CommandReceiptService.ts';

export async function publishDoctorAssignmentRemoval(assignment: any, actorId: string) {
  await eventBus.publishDurable({ eventId: `crm:assignment:removed:${assignment.id}:${assignment.assignmentRevision}`, eventType: 'crm.doctor.assignment.removed', category: 'task', organizationId: String(assignment.organizationId), createdBy: actorId, metadata: { assignmentId: assignment.id, assignmentRevision: assignment.assignmentRevision } });
}

// Call within the named staff/membership command's transaction.
export async function deactivateDoctorAssignments(organizationId: string, userId: string, actorId: string) {
  const assignments = await DoctorAssignment.find({ organizationId, doctorId: userId, isActive: true }).select('_id').limit(1001).lean();
  if (assignments.length > 1000) throw new CommandError(409, 'This doctor requires a staged assignment review');
  for (const assignment of assignments) {
    const removed = await DoctorAssignment.findOneAndUpdate({ _id: assignment._id, organizationId, doctorId: userId, isActive: true }, { $set: { isActive: false }, $inc: { assignmentRevision: 1 } }, { returnDocument: 'after' });
    if (removed) await publishDoctorAssignmentRemoval(removed, actorId);
  }
}

// Removing a particular assignment creates bounded administrative review work.
// It never infers consent, cancels a visit or changes an active consultation.
export async function handleDoctorAssignmentRemoval(event: DomainEventPayload) {
  const data = event.metadata;
  if (!event.eventId || !event.organizationId || !data?.assignmentId || !Number.isInteger(data.assignmentRevision)) throw new Error('Invalid assignment recovery event');
  await withTransaction(async () => {
    const assignment = await DoctorAssignment.findOneAndUpdate({ _id: data.assignmentId, organizationId: event.organizationId, isActive: false, assignmentRevision: data.assignmentRevision }, { $inc: { recoveryScanRevision: 1 } }, { returnDocument: 'after' });
    if (!assignment || !await Location.exists({ _id: assignment.locationId, organizationId: event.organizationId, isActive: true })) return;
    const timezone = await getLocationTimezone(String(assignment.locationId));
    const start = locationDayRange(locationDateKey(new Date(), timezone), timezone).start;
    const visits = await Appointment.find({ organizationId: event.organizationId, locationId: assignment.locationId, doctorId: assignment.doctorId, appointmentTime: { $gte: start }, status: { $in: ['pending_payment', 'pending', 'confirmed', 'checked-in', 'standby', 'disruption_triage'] }, ...(data.cursor ? { _id: { $gt: data.cursor } } : {}) }).sort({ _id: 1 }).limit(100);
    for (const appointment of visits) {
      const relationship = await PatientRelationship.findOne({ organizationId: event.organizationId, locationId: assignment.locationId, patientId: appointment.patientId, status: 'active' }).select('ownerId').lean();
      await createCrmTask({ organizationId: event.organizationId!, locationId: String(assignment.locationId), patientId: String(appointment.patientId), appointmentId: appointment.id, actorId: event.createdBy, assignedTo: relationship?.ownerId?.toString(), kind: 'crm_recovery', title: 'Review removed doctor assignment', dueDate: new Date(), dedupeKey: `assignment-recovery:${assignment.id}:${data.assignmentRevision}:${appointment.id}` });
    }
    if (visits.length === 100) {
      const cursor = visits[visits.length - 1].id;
      await eventBus.publishDurable({ ...event, eventId: `crm:assignment:page:${assignment.id}:${data.assignmentRevision}:${cursor}`, metadata: { ...data, cursor } });
    }
  });
}
eventBus.subscribe('crm.doctor.assignment.removed', handleDoctorAssignmentRemoval);

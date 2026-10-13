import { Appointment } from '../models/Appointment.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { createCrmTask, publishCrmTaskEvent } from './CrmTaskService.ts';
import { locationDateKey, locationClockMinutes, locationLocalTimeToDate, getLocationTimezone } from '../utilities/locationTime.ts';
import { AppointmentDomainError } from './AppointmentService.ts';
import { TaskModel } from '../models/Task.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
export async function recommendationDueDate(locationId: string, timeline?: string, explicit?: string, now = new Date()) {
  if (explicit) {
    const date = new Date(explicit);
    if (!Number.isFinite(date.getTime()) || date <= now) throw new AppointmentDomainError('Choose a future follow-up recommendation date', 400);
    return date;
  }
  const match = /^(\d{1,3})\s+(day|week|month)s?$/i.exec(timeline?.trim() || '');
  if (!match) return undefined; // Ambiguous legacy text is a review task, never a guessed booking.
  const count = Number(match[1]), unit = match[2].toLowerCase();
  if (count < 1 || count > (unit === 'month' ? 12 : unit === 'week' ? 52 : 365)) return undefined;
  const timezone = await getLocationTimezone(locationId), date = new Date(`${locationDateKey(now, timezone)}T00:00:00Z`), day = date.getUTCDate();
  if (unit === 'month') { date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + count); const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate(); date.setUTCDate(Math.min(day, last)); }
  else date.setUTCDate(day + count * (unit === 'week' ? 7 : 1));
  const minutes = locationClockMinutes(now, timezone);
  try { return locationLocalTimeToDate(date.toISOString().slice(0, 10), `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`, timezone); }
  catch { return undefined; } // A nonexistent DST time needs review instead of an invented instant.
}
export async function recordFollowUpRecommendation(appointment: any, actorId: string, dueDate?: Date) {
  const organizationId = String(appointment.organizationId), locationId = String(appointment.locationId), patientId = String(appointment.patientId);
  const relationship = await PatientRelationship.findOne({ organizationId, patientId, locationId, status: 'active' }).select('ownerId').lean();
  const task = await createCrmTask({ organizationId, locationId, patientId, appointmentId: appointment.id, actorId, kind: dueDate ? 'crm_followup' : 'crm_review',
    title: dueDate ? 'Arrange recommended care follow-up' : 'Review ambiguous follow-up recommendation', dueDate: dueDate || new Date(),
    assignedTo: relationship?.ownerId?.toString(), dedupeKey: `followup:${appointment.id}`, followUpReview: dueDate ? undefined : 'ambiguous' });
  await Appointment.updateOne({ _id: appointment._id, organizationId }, { $set: { followUpTaskId: task._id, followUpWorkflow: dueDate ? 'recommended' : 'review_required', followUpDueAt: dueDate || null } });
  appointment.followUpTaskId = task._id; appointment.followUpWorkflow = dueDate ? 'recommended' : 'review_required'; appointment.followUpDueAt = dueDate;
  return task;
}
// Invoked by the controlled legacy review/backfill; it neither confirms nor cancels a booking.
export async function recordLegacyFollowUpReview(appointment: any, actorId: string) {
  if (!appointment.followUpAppointmentId) throw new AppointmentDomainError('A legacy follow-up link is required', 400);
  return createCrmTask({ organizationId: String(appointment.organizationId), locationId: String(appointment.locationId), patientId: String(appointment.patientId), appointmentId: appointment.id,
    actorId, kind: 'crm_review', title: 'Review legacy follow-up booking with patient', dueDate: new Date(), dedupeKey: `legacy-followup:${appointment.id}`, followUpReview: 'legacy' });
}
export async function recordAppointmentRecovery(appointment: any, actorId: string, outcome: string) {
  const ref = (value: any) => value?._id?.toString() || value?.toString();
  const organizationId = ref(appointment.organizationId), locationId = ref(appointment.locationId), patientId = ref(appointment.patientId);
  if (!organizationId || !locationId || !patientId) throw new AppointmentDomainError('Appointment context requires administrative review', 409);
  const relationship = await PatientRelationship.findOne({ organizationId, patientId, locationId, status: 'active' }).select('ownerId').lean();
  return createCrmTask({ organizationId, locationId, patientId, appointmentId: appointment.id || ref(appointment._id), actorId,
    kind: 'crm_recovery', title: outcome === 'disruption' ? 'Review doctor disruption recovery' : outcome === 'no-show' ? 'Review missed appointment' : 'Review cancelled appointment',
    dueDate: new Date(), assignedTo: relationship?.ownerId?.toString(), dedupeKey: `recovery:${appointment.id || ref(appointment._id)}:${outcome}` });
}
export async function resolveAppointmentRecovery(appointment: any, actorId: string | undefined, outcome: string, resultAppointmentId?: string) {
  const tasks = await TaskModel.find({ organizationId: appointment.organizationId, appointmentId: appointment._id, kind: 'crm_recovery', status: { $ne: 'completed' } }).select('_id revision locationId patientId').limit(21);
  if (tasks.length > 20) throw new AppointmentDomainError('Recovery task history requires administrative review', 409);
  for (const task of tasks) {
    const changed = await TaskModel.updateOne({ _id: task._id, organizationId: appointment.organizationId, revision: task.revision }, { $set: { status: 'completed', outcome, completedAt: new Date(), ...(resultAppointmentId ? { resultAppointmentId } : {}) }, $unset: { snoozedUntil: 1 }, $inc: { revision: 1 } });
    if (changed.modifiedCount !== 1) throw new AppointmentDomainError('Recovery task changed during appointment recovery', 409);
    await CrmActivity.create({ organizationId: appointment.organizationId, locationId: task.locationId, patientId: task.patientId, appointmentId: appointment._id, taskId: task._id, actorId, kind: 'appointment_recovery_resolved', outcome });
    await publishCrmTaskEvent(await TaskModel.findById(task._id), actorId);
  }
}

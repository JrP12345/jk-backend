import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment.ts';
import { Location } from '../models/Location.ts';
import { User } from '../models/User.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { Organization } from '../models/Organization.ts';
import { TaskModel } from '../models/Task.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { Patient } from '../models/Patient.ts';
import { CrmActivity } from '../models/CrmActivity.ts';
import { getOrganizationPatient } from './PatientRecordAccessService.ts';
import { getEffectivePermissions } from '../utilities/permissions.ts';
import { executeRecordedCommand, CommandError } from './CommandReceiptService.ts';
import { recordFollowUpRecommendation, recordLegacyFollowUpReview } from './CareFollowUpService.ts';
import { requestContextStore } from '../utilities/context.ts';

export interface ReviewedCrmBackfill {
  organizationId: string; actorId: string; batchId: string; clientRequestId: string;
  appointmentId: string; expectedUpdatedAt: string; action: 'legacy_followup_review' | 'recommendation_review' | 'relationship_initialize';
}
interface BackfillResult { taskId?: string; relationshipId?: string; appointmentId: string; status: string; replayed: boolean }
async function authority(input: ReviewedCrmBackfill) {
  const [member, actor, org] = await Promise.all([OrgMember.findOne({ organizationId: input.organizationId, userId: input.actorId }).lean(), User.findById(input.actorId).select('isActive').lean(), Organization.findById(input.organizationId).select('isActive status').lean()]);
  if (!member || !actor?.isActive || !org?.isActive || org.status === 'inactive' || member.locationAccess?.mode !== 'all') throw new CommandError(403, 'A reviewed organization-wide operator grant is required');
  const permissions = await getEffectivePermissions(member.role, input.organizationId, 1, true);
  if (!['VIEW_CRM', 'MANAGE_CRM_TASKS', 'MANAGE_PATIENTS', 'MANAGE_APPOINTMENTS'].every(code => permissions.has(code))) throw new CommandError(403, 'Reviewed backfill authority is unavailable');
}
/** Trusted operator tooling only; no public route. Apply a separately authorized manifest against matching snapshot versions. */
export async function applyReviewedCrmBackfill(input: ReviewedCrmBackfill): Promise<BackfillResult> {
  if (![input.organizationId, input.actorId, input.appointmentId].every(id => /^[a-fA-F0-9]{24}$/.test(id) && mongoose.isValidObjectId(id))) throw new CommandError(400, 'Reviewed canonical identifiers are required');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.batchId) || !Number.isFinite(new Date(input.expectedUpdatedAt).getTime()) || !['legacy_followup_review', 'recommendation_review', 'relationship_initialize'].includes(input.action)) throw new CommandError(400, 'A valid reviewed batch, source version and action are required');
  return requestContextStore.run({ ...requestContextStore.getStore(), organizationId: input.organizationId }, async () => {
    await authority(input);
    const result = await executeRecordedCommand(`crm-backfill:${input.organizationId}:${input.batchId}`, input.clientRequestId, input, async () => {
      await authority(input);
      const source = await Appointment.findOne({ _id: input.appointmentId, organizationId: input.organizationId, updatedAt: new Date(input.expectedUpdatedAt) });
      if (!source || (input.action !== 'relationship_initialize' && source.status !== 'completed')) throw new CommandError(409, 'Source changed or needs clinical/identity review');
      if (!await Location.exists({ _id: source.locationId, organizationId: input.organizationId }) || !await getOrganizationPatient(String(source.patientId), input.organizationId)) throw new CommandError(409, 'Canonical source references need review');
      if (input.action === 'relationship_initialize') {
        // A historical foreign-organization reference needs independent identity
        // association review; the manifest never creates that authority.
        if (!await Patient.exists({ _id: source.patientId, organizationId: input.organizationId }).setOptions({ bypassTenantFilter: true })) throw new CommandError(409, 'Cross-organization identity needs independent association review');
        if (await PatientRelationship.exists({ organizationId: input.organizationId, patientId: source.patientId })) throw new CommandError(409, 'Relationship already has recorded context; review it without overwriting');
        const relationship = await PatientRelationship.create({ organizationId: input.organizationId, patientId: source.patientId, locationId: source.locationId, contact: { availability: 'unknown', recipientType: 'patient' }, preferences: { preferredChannel: 'none' } });
        await CrmActivity.create({ organizationId: input.organizationId, patientId: source.patientId, locationId: source.locationId, appointmentId: source.id, actorId: input.actorId, eventKey: `crm-backfill:${input.batchId}:${input.clientRequestId}`, kind: 'relationship_initialized', outcome: 'reviewed_legacy_context' });
        await AuditLog.create({ organizationId: input.organizationId, userId: input.actorId, category: 'ADMIN', action: 'CRM_LEGACY_RELATIONSHIP_PREPARED', targetId: relationship._id, targetModel: 'PatientRelationship', details: { batchId: input.batchId, appointmentId: source.id } });
        return relationship.id;
      }
      if (source.followUpTaskId || source.followUpWorkflow || source.followUpConfirmationEvidence) throw new CommandError(409, 'Follow-up already has recorded workflow evidence');
      let task;
      if (input.action === 'legacy_followup_review') {
        if (!source.followUpAppointmentId || !await Appointment.exists({ _id: source.followUpAppointmentId, organizationId: input.organizationId, patientId: source.patientId })) throw new CommandError(409, 'Legacy follow-up reference needs reconciliation');
        task = await recordLegacyFollowUpReview(source, input.actorId);
        const changed = await Appointment.updateOne({ _id: source.id, organizationId: input.organizationId, updatedAt: new Date(input.expectedUpdatedAt) }, { $set: { followUpTaskId: task._id, followUpWorkflow: 'review_required' } });
        if (changed.modifiedCount !== 1) throw new CommandError(409, 'Source changed during review preparation');
      } else {
        if (!source.followUpRecommended || source.followUpAppointmentId) throw new CommandError(409, 'A standalone legacy recommendation is required');
        // Preserve uncertainty: historical calendar text is reviewed by a human,
        // rather than scheduling a new appointment or guessing a past due date.
        task = await recordFollowUpRecommendation(source, input.actorId);
      }
      await AuditLog.create({ organizationId: input.organizationId, userId: input.actorId, category: 'ADMIN', action: 'CRM_LEGACY_REVIEW_PREPARED', targetId: source._id, targetModel: 'Appointment', details: { batchId: input.batchId, taskId: task.id, action: input.action } });
      return task.id;
    });
    if (input.action === 'relationship_initialize') {
      const relationship = await PatientRelationship.findOne({ _id: result.resultId, organizationId: input.organizationId }).select('status');
      if (!relationship) throw new CommandError(404, 'Recorded relationship is unavailable');
      return { relationshipId: relationship.id, appointmentId: input.appointmentId, status: relationship.status, replayed: result.replayed };
    }
    const task = await TaskModel.findOne({ _id: result.resultId, organizationId: input.organizationId }).select('status appointmentId');
    if (!task) throw new CommandError(404, 'Recorded review task is unavailable');
    return { taskId: task.id, appointmentId: String(task.appointmentId), status: task.status, replayed: result.replayed };
  });
}

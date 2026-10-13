import mongoose from 'mongoose';
import { Appointment } from '../models/Appointment.ts';
import { Patient } from '../models/Patient.ts';
import { Location } from '../models/Location.ts';
import { Invoice } from '../models/Invoice.ts';
import { TaskModel } from '../models/Task.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { Organization } from '../models/Organization.ts';

export type CrmMigrationIssue = 'branch_reference' | 'patient_reference' | 'relationship_missing' | 'legacy_followup_review' | 'recommendation_review' | 'financial_reference' | 'financial_state_review' | 'disruption_review';
/** Read-only, explicitly scoped and paginated. No consent inference, merges, booking changes or historical notification replay. */
export async function reviewCrmMigrationPage(input: { organizationId: string; cursor?: string; limit?: number }) {
  if (!mongoose.isValidObjectId(input.organizationId) || (input.cursor && !mongoose.isValidObjectId(input.cursor))) throw new Error('Valid organization and cursor references are required');
  const limit = input.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Review page size must be between 1 and 200');
  if (!await Organization.exists({ _id: input.organizationId })) throw new Error('Organization not found');
  const rows = await Appointment.find({ organizationId: input.organizationId, ...(input.cursor ? { _id: { $gt: input.cursor } } : {}) })
    .select('locationId patientId updatedAt status paymentStatus invoiceId followUpAppointmentId followUpConfirmationEvidence followUpRecommended followUpTaskId followUpWorkflow disruptionReviewRequiredAt')
    .sort({ _id: 1 }).limit(limit + 1).maxTimeMS(8000).lean();
  const page = rows.slice(0, limit), references = page.map(row => row._id);
  const [branches, patients, invoices, relationships, tasks] = await Promise.all([
    Location.find({ _id: { $in: page.map(row => row.locationId) }, organizationId: input.organizationId }).select('_id').lean(),
    Patient.find({ _id: { $in: page.map(row => row.patientId) } }).select('_id').setOptions({ bypassTenantFilter: true }).lean(),
    Invoice.find({ organizationId: input.organizationId, appointmentId: { $in: references }, deletedAt: null }).select('appointmentId patientId locationId status amountPaid totalAmount').lean(),
    PatientRelationship.find({ organizationId: input.organizationId, patientId: { $in: page.map(row => row.patientId) } }).select('patientId').lean(),
    TaskModel.find({ organizationId: input.organizationId, appointmentId: { $in: references }, kind: { $in: ['crm_recovery', 'crm_followup', 'crm_review'] } }).select('appointmentId kind followUpReview dedupeKey').lean(),
  ]);
  const branchIds = new Set(branches.map(row => String(row._id))), patientIds = new Set(patients.map(row => String(row._id))), relationshipIds = new Set(relationships.map(row => String(row.patientId)));
  const counts = Object.fromEntries(['branch_reference', 'patient_reference', 'relationship_missing', 'legacy_followup_review', 'recommendation_review', 'financial_reference', 'financial_state_review', 'disruption_review'].map(code => [code, 0])) as Record<CrmMigrationIssue, number>;
  const reviews = page.map(row => {
    const issues: CrmMigrationIssue[] = [], id = String(row._id);
    if (!branchIds.has(String(row.locationId))) issues.push('branch_reference');
    if (!patientIds.has(String(row.patientId))) issues.push('patient_reference');
    if (!relationshipIds.has(String(row.patientId))) issues.push('relationship_missing');
    if (row.followUpAppointmentId && !row.followUpConfirmationEvidence && !tasks.some(task => task.dedupeKey === `legacy-followup:${id}`)) issues.push('legacy_followup_review');
    if (row.followUpRecommended && !row.followUpTaskId && !row.followUpWorkflow) issues.push('recommendation_review');
    const invoice = invoices.find(item => String(item.appointmentId) === id && (!row.invoiceId || String(item._id) === String(row.invoiceId)));
    if ((row.invoiceId || ['paid', 'pending', 'refunded', 'refund_pending'].includes(row.paymentStatus)) && (!invoice || String(invoice.patientId) !== String(row.patientId) || String(invoice.locationId) !== String(row.locationId))) issues.push('financial_reference');
    if (invoice && ((row.paymentStatus === 'paid' && (!['paid', 'partially_paid'].includes(invoice.status) || !Number.isFinite(invoice.amountPaid) || invoice.amountPaid <= 0)) || (row.status === 'confirmed' && row.paymentStatus === 'pending'))) issues.push('financial_state_review');
    if ((row.status === 'disruption_triage' || row.disruptionReviewRequiredAt) && !tasks.some(task => String(task.appointmentId) === id && task.kind === 'crm_recovery')) issues.push('disruption_review');
    issues.forEach(code => counts[code]++);
    return { appointmentId: id, patientId: String(row.patientId), locationId: String(row.locationId), expectedUpdatedAt: row.updatedAt?.toISOString() || null, issues };
  }).filter(row => row.issues.length);
  const unreviewedBranchMembers = await OrgMember.countDocuments({ organizationId: input.organizationId, $or: [{ locationAccess: { $exists: false } }, { locationAccess: null }] }).maxTimeMS(8000);
  return { organizationId: input.organizationId, readOnly: true as const, scanned: page.length, pageCounts: counts, reviews, unreviewedBranchMembers,
    nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
    complete: rows.length <= limit, countsScope: 'this_page' as const };
}

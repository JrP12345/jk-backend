import { Appointment } from '../models/Appointment.ts';
import { PatientRelationship } from '../models/PatientRelationship.ts';
import { TaskModel } from '../models/Task.ts';
import { Organization } from '../models/Organization.ts';
import { Location } from '../models/Location.ts';
import { getOrganizationPatient } from './PatientRecordAccessService.ts';
import { getPatientConsents } from './PatientConsentService.ts';
import { organizationCommunicationRecipient } from './FamilyAuthorityService.ts';
import { computeBlindIndex } from '../utilities/cryptoEnvelope.ts';
import { OrgMember } from '../models/OrgMember.ts';
import { User } from '../models/User.ts';
import { resolveStaffLocationGrant } from './LocationAccessService.ts';
import { getEffectivePermissions } from '../utilities/permissions.ts';
import { WhatsAppRecipient } from '../models/WhatsAppRecipient.ts';
import { phoneHash } from './WhatsAppSendPolicy.ts';
import { DPDPConsent } from '../models/DPDPConsent.ts';
import { crmEntitlementActive } from './CrmEntitlementService.ts';
import { Invoice } from '../models/Invoice.ts';
import { getLocationTimezone, locationDateKey } from '../utilities/locationTime.ts';

export type PatientCommunicationPurpose = 'care_operations' | 'care_followup' | 'feedback';
export interface PatientCommunicationContext {
  organizationId: string; locationId?: string; patientId?: string; appointmentId?: string; taskId?: string;
  purpose?: PatientCommunicationPurpose; actorId?: string; recipientHash?: string; consentRevision?: number; appointmentStatus?: string; consentEvidenceHash?: string;
  appointmentTime?: string; appointmentDoctorId?: string; communicationRevision?: number;
  familyRelationshipId?: string; familyAuthorityRevision?: number;
  communicationAction?: 'booked' | 'rescheduled' | 'cancelled' | 'prescription' | 'disruption' | 'refund' | 'turn_approaching' | 'queue_delay' | 'queue_tracker';
  automated?: boolean;
  invoiceId?: string; paymentReference?: string; paymentAmount?: number; paymentCurrency?: string; paymentMethod?: string;
}
export class CommunicationPolicyError extends Error {
  public readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
    this.name = 'CommunicationPolicyError';
  }
}
const deny = (reason: string): never => { throw new CommunicationPolicyError(reason); };
export function normalizedCommunicationRecipient(value: string, channel: 'whatsapp' | 'email' | 'phone') {
  if (channel === 'email') return value.trim().toLowerCase();
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 ? `91${digits}` : digits;
}
// Pure authorization read, used before enqueue and again immediately before dispatch.
// Family recipients require separately reviewed, current organization authority.
export async function patientCommunicationPolicy(context: PatientCommunicationContext, channel: 'whatsapp' | 'email' | 'phone', intendedRecipient?: string) {
  if (context.communicationAction === 'queue_tracker' && (context.automated !== false || !context.actorId)) deny('COMMUNICATION_CONTEXT_REQUIRED');
  let { organizationId, locationId, patientId } = context;
  let appointmentStatus: string | undefined;
  let appointmentTime: string | undefined, appointmentDoctorId: string | undefined, communicationRevision: number | undefined;
  if (context.invoiceId) {
    const invoice = await Invoice.findOne({ _id: context.invoiceId, organizationId, appointmentId: context.appointmentId, patientId, locationId, deletedAt: null }).select('status currency payments').lean();
    const entry = invoice?.payments.find((row: { referenceNumber?: string; operationKey?: string; amount: number; paymentMethod: string }) => row.referenceNumber === context.paymentReference || row.operationKey === context.paymentReference);
    if (!context.paymentReference || !Number.isFinite(context.paymentAmount) || Number(context.paymentAmount) <= 0 || !invoice || !['paid', 'partially_paid'].includes(invoice.status)
      || !entry || entry.amount !== context.paymentAmount || entry.paymentMethod !== context.paymentMethod || (invoice.currency || 'INR') !== context.paymentCurrency) deny('COMMUNICATION_PAYMENT_SOURCE_CHANGED');
  }
  if (context.appointmentId) {
    const appointment = await Appointment.findOne({ _id: context.appointmentId, organizationId }).select('patientId locationId status appointmentTime doctorId communicationRevision paymentStatus');
    if (!appointment) deny('COMMUNICATION_SUBJECT_UNAVAILABLE');
    if (patientId && patientId !== String(appointment!.patientId)) deny('COMMUNICATION_SUBJECT_MISMATCH');
    if (locationId && locationId !== String(appointment!.locationId)) deny('COMMUNICATION_BRANCH_CHANGED');
    if (context.appointmentStatus && context.appointmentStatus !== appointment!.status) deny('COMMUNICATION_SOURCE_CHANGED');
    if (context.communicationAction === 'refund' && appointment!.paymentStatus !== 'refunded') deny('COMMUNICATION_SOURCE_CHANGED');
    appointmentTime = appointment!.appointmentTime.toISOString(); appointmentDoctorId = String(appointment!.doctorId); communicationRevision = appointment!.communicationRevision || 0;
    if ((context.appointmentTime && context.appointmentTime !== appointmentTime) || (context.appointmentDoctorId && context.appointmentDoctorId !== appointmentDoctorId) || (context.communicationRevision !== undefined && context.communicationRevision !== communicationRevision)) deny('COMMUNICATION_SOURCE_CHANGED');
    appointmentStatus = appointment!.status;
    patientId = String(appointment!.patientId); locationId = String(appointment!.locationId);
    if (['turn_approaching', 'queue_delay', 'queue_tracker'].includes(context.communicationAction || '')) {
      const zone = await getLocationTimezone(locationId);
      if (!['pending', 'confirmed', 'checked-in'].includes(appointmentStatus)
        || locationDateKey(appointment!.appointmentTime, zone) !== locationDateKey(new Date(), zone)) deny('COMMUNICATION_SOURCE_CHANGED');
    }
  }
  if (!patientId || !locationId) deny('COMMUNICATION_CONTEXT_REQUIRED');
  const [org, branch, patient, relationship] = await Promise.all([
    Organization.findById(organizationId).select('isActive status whatsappConfig.mode whatsappConfig.notifications').lean(),
    Location.findOne({ _id: locationId, organizationId }).select('isActive').lean(),
    getOrganizationPatient(patientId!, organizationId),
    PatientRelationship.findOne({ patientId, organizationId }).lean(),
  ]);
  if (!org || org.isActive === false || org.status === 'inactive' || !branch || branch.isActive === false) deny('COMMUNICATION_WORKSPACE_INACTIVE');
  if (context.automated && !await crmEntitlementActive(organizationId)) deny('COMMUNICATION_ENTITLEMENT_INACTIVE');
  if (!patient || relationship?.status === 'archived') deny('COMMUNICATION_SUBJECT_UNAVAILABLE');
  if (!context.appointmentId && String(relationship?.locationId || '') !== locationId) deny('COMMUNICATION_BRANCH_CHANGED');
  if (String(relationship?.locationId || '') !== locationId && !await Appointment.exists({ organizationId, locationId, patientId })) deny('COMMUNICATION_SUBJECT_UNAVAILABLE');
  if (relationship?.preferences?.doNotContact || relationship?.preferences?.preferredChannel === 'none') deny('COMMUNICATION_DO_NOT_CONTACT');
  const selectedRecipient = await organizationCommunicationRecipient(patientId!, organizationId);
  if (selectedRecipient.recipientType === 'family' && (!selectedRecipient.available || selectedRecipient.familyAuthorityRevision === undefined)) deny('COMMUNICATION_FAMILY_REVIEW_REQUIRED');
  // Existing appointment templates carry private tracker/document capabilities.
  // A service communication grant does not delegate those capabilities.
  if (selectedRecipient.recipientType === 'family' && (context.communicationAction || context.invoiceId)) deny('COMMUNICATION_FAMILY_CLINICAL_REVIEW_REQUIRED');
  if (context.familyRelationshipId && (context.familyRelationshipId !== selectedRecipient.familyRelationshipId || context.familyAuthorityRevision !== selectedRecipient.familyAuthorityRevision)) deny('COMMUNICATION_FAMILY_AUTHORITY_CHANGED');
  if (['unreachable', 'invalid'].includes(relationship?.contact?.availability || '')) deny('COMMUNICATION_CONTACT_UNAVAILABLE');
  if (channel === 'whatsapp' && patient!.optOutWhatsApp) deny('PATIENT_OPTED_OUT_WHATSAPP');
  if (context.taskId) {
    const task = await TaskModel.findOne({ _id: context.taskId, organizationId, locationId, patientId }).select('status revision');
    if (!task || task.status === 'completed') deny('COMMUNICATION_TASK_NO_LONGER_ACTIVE');
  }
  if (context.actorId) {
    const [member, actor] = await Promise.all([OrgMember.findOne({ userId: context.actorId, organizationId }).select('role').lean(), User.findById(context.actorId).select('isActive').lean()]);
    if (!member || !actor || actor.isActive === false) deny('COMMUNICATION_ACTOR_REVOKED');
    const permissions = await getEffectivePermissions(member!.role, organizationId, 1, true);
    if (!permissions.has('COMMUNICATE_PATIENTS')) deny('COMMUNICATION_ACTOR_REVOKED');
    const grant = await resolveStaffLocationGrant(context.actorId, organizationId, member!.role, true);
    if (grant && !grant.includes(locationId!)) deny('COMMUNICATION_ACTOR_REVOKED');
  }
  const recipient = channel === 'email' ? selectedRecipient.email : selectedRecipient.phone;
  if (!recipient) deny('COMMUNICATION_RECIPIENT_REQUIRED');
  const normalized = normalizedCommunicationRecipient(recipient!, channel);
  if (channel === 'email' ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) : !/^[1-9]\d{7,14}$/.test(normalized)) deny('COMMUNICATION_INVALID_RECIPIENT');
  if (intendedRecipient && normalized !== normalizedCommunicationRecipient(intendedRecipient, channel)) deny('COMMUNICATION_RECIPIENT_CHANGED');
  const familyBinding = selectedRecipient.recipientType === 'family' ? `:family:${selectedRecipient.familyRelationshipId}:${selectedRecipient.familyAuthorityRevision}` : '';
  const recipientHash = computeBlindIndex(`${organizationId}:${patientId}:${channel}:${normalized}${familyBinding}`);
  if (context.recipientHash && context.recipientHash !== recipientHash) deny('COMMUNICATION_RECIPIENT_CHANGED');
  if (channel === 'whatsapp') {
    if (org?.whatsappConfig?.mode === 'disabled') deny('WHATSAPP_DISABLED_FOR_ORGANIZATION');
    const toggles = { booked: 'sendBookingConfirmation', rescheduled: 'sendBookingConfirmation', cancelled: 'sendAppointmentCancellation', prescription: 'sendConsultationComplete', disruption: 'sendDisruptionAlert', refund: 'sendDisruptionAlert', turn_approaching: 'sendTurnApproaching', queue_delay: 'sendQueueDelayAlert', queue_tracker: undefined };
    const toggle = context.communicationAction ? toggles[context.communicationAction] : undefined;
    if (toggle && (org?.whatsappConfig?.notifications as any)?.[toggle] === false) deny('COMMUNICATION_CHANNEL_DISABLED');
    const senderScope = org?.whatsappConfig?.mode === 'dedicated' ? organizationId : 'platform';
    if (await WhatsAppRecipient.exists({ scope: senderScope, phoneHash: phoneHash(normalized), optedOut: true })) deny('PATIENT_OPTED_OUT_WHATSAPP');
  }
  const consent = await getPatientConsents(patientId!, organizationId);
  const purposes = [channel === 'email' ? 'COMMUNICATION_EMAIL' : channel === 'phone' ? 'COMMUNICATION_PHONE' : 'COMMUNICATION_WHATSAPP', ...(context.purpose === 'care_followup' ? ['PREVENTIVE_HEALTH_RECALLS'] : context.purpose === 'feedback' ? ['FEEDBACK_AND_SURVEYS'] : [])];
  if (purposes.some(purpose => consent.purposes.find(row => row.purpose === purpose)?.status !== 'GRANTED')) deny('COMMUNICATION_CONSENT_REQUIRED');
  const evidence = await DPDPConsent.findOne({ patientId, organizationId, revision: consent.revision }).select('purposes.purpose purposes.evidence.activityId').lean();
  if (!evidence) deny('COMMUNICATION_CONSENT_CHANGED');
  const consentEvidenceHash = computeBlindIndex(JSON.stringify(purposes.map(purpose => [purpose, evidence!.purposes.find(row => row.purpose === purpose)?.evidence?.activityId?.toString()])));
  if (context.consentEvidenceHash && context.consentEvidenceHash !== consentEvidenceHash) deny('COMMUNICATION_CONSENT_CHANGED');
  return { recipient: normalized, patient, context: { ...context, patientId, locationId,
    familyRelationshipId: selectedRecipient.familyRelationshipId, familyAuthorityRevision: selectedRecipient.familyAuthorityRevision,
    appointmentStatus: context.invoiceId ? undefined : appointmentStatus, appointmentTime: context.invoiceId ? undefined : appointmentTime,
    appointmentDoctorId: context.invoiceId ? undefined : appointmentDoctorId, communicationRevision: context.invoiceId ? undefined : communicationRevision,
    purpose: context.purpose || 'care_operations', recipientHash, consentRevision: consent.revision, consentEvidenceHash } as PatientCommunicationContext };
}

import mongoose from 'mongoose';
import type { DomainEventPayload } from '../events/types.ts';
import { User } from '../models/User.ts';
import { Patient } from '../models/Patient.ts';
import { Appointment } from '../models/Appointment.ts';
import { Location } from '../models/Location.ts';
import { Organization } from '../models/Organization.ts';
import { LabOrder } from '../models/LabOrder.ts';

// The generic notification queue has no pinned purpose or recipient evidence.
// Patient care messages must use CommunicationOutbox for external delivery.
export async function patientNotificationAudience(event: DomainEventPayload) {
  const deny = { protected: true, allowed: false, appointmentId: undefined as string | undefined, orderId: undefined as string | undefined, patientId: undefined as string | undefined, locationId: undefined as string | undefined };
  if (!event.targetUserId || !mongoose.isValidObjectId(event.targetUserId)) return deny;
  const target = await User.findById(event.targetUserId).select('role isActive').lean();
  if (!target?.isActive) return deny;
  const appointmentId = event.metadata?.appointmentId || event.metadata?.context?.appointmentId;
  const patientId = event.metadata?.patientId || event.metadata?.context?.patientId;
  const orderId = event.metadata?.orderId;
  const care = ['patient', 'clinical', 'labs', 'consent', 'billing'].includes(event.category);
  if (!care && !appointmentId && !patientId && !orderId) return { ...deny, protected: false, allowed: true };
  const visit = mongoose.isValidObjectId(appointmentId) ? await Appointment.findById(appointmentId).select('organizationId locationId patientId communicationRevision').lean() : null;
  const order = mongoose.isValidObjectId(orderId) ? await LabOrder.findById(orderId).select('organizationId locationId patientId status deletedAt').lean() : null;
  if (orderId && (!order || order.deletedAt)) return deny;
  const source = order || visit;
  const patient = source ? await Patient.findById(source.patientId).select('userId').setOptions({ bypassTenantFilter: true }).lean() : mongoose.isValidObjectId(patientId) ? await Patient.findById(patientId).select('userId').setOptions({ bypassTenantFilter: true }).lean() : null;
  const owner = patient?.userId?.toString() === event.targetUserId;
  if (!owner && !['patient', 'family_member', 'guest'].includes(target.role)) return { ...deny, protected: false, allowed: true };
  // Family grants are a separately reviewed change and remain disabled.
  if (!owner || target.role === 'family_member' || !event.organizationId || !source || String(source.organizationId) !== event.organizationId) return deny;
  if (patientId && String(source.patientId) !== String(patientId)) return deny;
  if (order && visit && (String(order.patientId) !== String(visit.patientId) || String(order.locationId) !== String(visit.locationId))) return deny;
  if (order && event.metadata?.context?.orderStatus !== undefined && event.metadata.context.orderStatus !== order.status) return deny;
  const pinned = event.metadata?.context?.communicationRevision;
  if (pinned !== undefined && (!visit || pinned !== (visit.communicationRevision || 0))) return deny;
  if (!await Organization.exists({ _id: source.organizationId, isActive: true }) || !await Location.exists({ _id: source.locationId, organizationId: source.organizationId, isActive: true })) return deny;
  return { protected: true, allowed: true, appointmentId: visit ? String(visit._id) : undefined, orderId: order ? String(order._id) : undefined, patientId: String(source.patientId), locationId: String(source.locationId) };
}

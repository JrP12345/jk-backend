import { Appointment } from '../models/Appointment.ts';
import { OutboundMessage } from '../models/OutboundMessage.ts';
import { AuditLog } from '../models/AuditLog.ts';
import { CommandError, executeRecordedCommand } from './CommandReceiptService.ts';
import { patientCommunicationPolicy, type PatientCommunicationContext } from './PatientCommunicationPolicy.ts';
import { enqueueWhatsAppDocument } from './CommunicationOutbox.ts';
import { appendTrackerCapability, issueAppointmentTrackerLink } from '../utilities/publicTracker.ts';
export async function queuePrescriptionCommunication(input: { appointmentId: string; organizationId: string; actorId: string; clientRequestId: string; phone?: string; communicationContext?: PatientCommunicationContext }) {
  const result = await executeRecordedCommand(`prescription-communication:${input.organizationId}:${input.actorId}`, input.clientRequestId, input, async () => {
    const appointment = await Appointment.findOne({ _id: input.appointmentId, organizationId: input.organizationId });
    if (!appointment || appointment.status !== 'completed') throw new CommandError(409, 'Only a completed visit can queue its existing prescription');
    const decision = await patientCommunicationPolicy({ ...input.communicationContext, organizationId: input.organizationId, appointmentId: input.appointmentId, actorId: input.actorId, purpose: 'care_operations', communicationAction: 'prescription' }, 'whatsapp', input.phone);
    const capability = await issueAppointmentTrackerLink(appointment);
    const queued = await enqueueWhatsAppDocument({ to: decision.recipient, organizationId: input.organizationId, communicationContext: decision.context, documentUrl: appendTrackerCapability(`/api/public/track/${appointment.id}/prescription/print`, capability.token), filename: 'Prescription.pdf', caption: 'Your clinic document is ready.', idempotencyKey: `rx:${input.organizationId}:${input.appointmentId}:${input.actorId}:${input.clientRequestId}` });
    if (!queued) throw new Error('Prescription queue persistence failed');
    await AuditLog.create({ organizationId: input.organizationId, userId: input.actorId, category: 'CLINICAL_WRITE', action: 'PRESCRIPTION_NOTIFICATION_QUEUED', targetId: appointment._id, targetModel: 'Appointment', details: { outboxId: queued.id, channel: 'whatsapp' } });
    return queued.id;
  });
  const queued = await OutboundMessage.findOne({ _id: result.resultId, 'payload.organizationId': input.organizationId });
  if (!queued) throw new CommandError(404, 'Prescription message is no longer available');
  return { appointmentId: input.appointmentId, outboxId: queued.id, channel: 'whatsapp', status: queued.status, replayed: result.replayed };
}

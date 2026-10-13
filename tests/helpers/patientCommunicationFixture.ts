import crypto from 'node:crypto';
import { Location } from '../../models/Location.ts';
import { Patient } from '../../models/Patient.ts';
import { PatientRelationship } from '../../models/PatientRelationship.ts';
import { OrgMember } from '../../models/OrgMember.ts';
import { Doctor } from '../../models/Doctor.ts';
import { User } from '../../models/User.ts';
import { Appointment } from '../../models/Appointment.ts';
import { CONSENT_NOTICE_VERSION, updatePatientConsents } from '../../services/PatientConsentService.ts';
export async function patientCommunicationFixture(organizationId: string, phone: string, existingPatientId?: string) {
  const member = await OrgMember.findOne({ organizationId, role: 'admin' });
  if (!member) throw new Error('Communication fixture requires a real organization admin');
  const patient = existingPatientId ? await Patient.findById(existingPatientId) : await Patient.create({ organizationId, name: 'Reviewed communication patient', phone, email: 'communication@example.test' });
  if (!patient) throw new Error('Fixture patient missing');
  const branch = await Location.create({ organizationId, name: 'Communication fixture branch', city: 'Mumbai' });
  await PatientRelationship.create({ organizationId, patientId: patient.id, locationId: branch.id });
  await updatePatientConsents(patient.id, organizationId, ['COMMUNICATION_WHATSAPP', ...(patient.email ? ['COMMUNICATION_EMAIL'] : [])].map(purpose => ({ purpose: purpose as any, status: 'GRANTED' })), { actorId: String(member.userId), clientRequestId: crypto.randomUUID(), expectedRevision: 0, method: 'in_person_confirmation', noticeVersion: CONSENT_NOTICE_VERSION, acknowledged: true, note: 'Test patient explicitly reviewed channel choices' });
  const doctorUser = await User.create({ name: 'Fixture clinician', role: 'doctor', email: `${crypto.randomUUID()}@example.test` });
  const doctor = await Doctor.create({ organizationId, userId: doctorUser.id });
  const newAppointment = () => Appointment.create({ organizationId, locationId: branch.id, patientId: patient.id, doctorId: doctor.id, appointmentTime: new Date(), appointmentType: 'reception', status: 'confirmed', tokenNumber: 12 });
  const appointment = await newAppointment();
  return { patient, branch, appointment, newAppointment, context: { organizationId, locationId: branch.id, patientId: patient.id } };
}

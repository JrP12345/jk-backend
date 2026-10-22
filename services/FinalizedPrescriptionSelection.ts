import { Encounter } from "../models/Encounter.ts";
import { ClinicalNote } from "../models/ClinicalNote.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { Appointment } from "../models/Appointment.ts";

/** A focused completion has no SOAP note. Its existing audit and sealed rows are its finalization evidence. */
export async function finalizedPrescriptionSelection(scope: { organizationId: any; locationId: any; patientId?: any }, encounterId?: any) {
  const encounters = await Encounter.find({ ...scope, ...(encounterId ? { _id: encounterId } : {}), status: "completed", deletedAt: null }).lean();
  const notes = encounters.length ? await ClinicalNote.find({ ...scope, encounterId: { $in: encounters.map(encounter => encounter._id) }, isLatest: true, deletedAt: null }).lean() : [];
  const appointments = encounters.length ? await Appointment.find({ ...scope,
    _id: { $in: encounters.map(encounter => encounter.appointmentId).filter(Boolean) }, status: "completed", deletedAt: null,
  }).select("patientId doctorId").lean() : [];
  const focused = encounters.length ? await AuditLog.find({ organizationId: scope.organizationId,
    action: "CONSULTATION_COMPLETED_WITHOUT_CLINICAL_NOTE", "details.encounterId": { $in: encounters.map(encounter => String(encounter._id)) },
  }).select("targetId details.encounterId").lean() : [];
  const clauses: any[] = [];
  for (const encounter of encounters) {
    if (encounter.appointmentId && !appointments.some(appointment => String(appointment._id) === String(encounter.appointmentId) &&
      String(appointment.patientId) === String(encounter.patientId) && String(appointment.doctorId) === String(encounter.doctorId))) continue;
    if (notes.filter(note => String(note.encounterId) === String(encounter._id)).length > 1) continue;
    const note = notes.find(note => String(note.encounterId) === String(encounter._id));
    const relationship = { encounterId: encounter._id, patientId: encounter.patientId, doctorId: encounter.doctorId };
    if (note) {
      if (["signed", "amended"].includes(note.status) && note.signature?.signedAt && String(note.patientId) === String(encounter.patientId) && String(note.doctorId) === String(encounter.doctorId)) {
        clauses.push({ ...relationship, _id: { $in: note.plan?.prescriptionIds || [] } });
      }
    } else if (encounter.appointmentId && focused.some(audit => String(audit.details?.encounterId) === String(encounter._id) && String(audit.targetId) === String(encounter.appointmentId))) {
      clauses.push(relationship);
    }
  }
  return { ...scope, isSealed: true, supersededByPrescriptionId: null, deletedAt: null,
    ...(clauses.length ? { $or: clauses } : { _id: { $in: [] } }) };
}

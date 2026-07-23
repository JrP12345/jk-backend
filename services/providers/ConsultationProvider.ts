import { Appointment } from "../../models/Appointment.ts";
import { ClinicalNote } from "../../models/ClinicalNote.ts";
import { Observation } from "../../models/Observation.ts";
import { Prescription } from "../../models/Prescription.ts";
import { User } from "../../models/User.ts";
import { Doctor } from "../../models/Doctor.ts";
import type {
  TimelineEvent,
  TimelineProvider,
  TimelineQueryOptions,
} from "../../types/timeline.ts";
import { TimelineSource } from "../../types/timeline.ts";

export class ConsultationProvider implements TimelineProvider {
  name = "ConsultationProvider";

  supports(query: TimelineQueryOptions): boolean {
    return !query.category || query.category === "all" || query.category === "consultation";
  }

  async fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]> {
    const events: TimelineEvent[] = [];

    // 1. Fetch Versioned Signed Clinical Notes
    const notes = await ClinicalNote.find({
      patientId: query.patientId,
      organizationId: query.organizationId,
      isLatest: true,
      status: { $in: ["signed", "amended"] },
    })
      .populate("doctorId", "name email")
      .populate("objective.observationIds")
      .populate("plan.prescriptionIds")
      .lean();

    const noteApptIds = new Set<string>();

    for (const note of notes as any[]) {
      noteApptIds.add(note.appointmentId?.toString());
      const doctorName = note.doctorId?.name || note.signature?.signerName || "Attending Physician";
      const doctorId = note.doctorId?._id?.toString() || note.doctorId?.toString() || "unknown";

      const diagnoses = (note.assessment?.diagnoses || []).map((d: any) => `${d.description} (${d.code})`);
      const rawDiagCodes = (note.assessment?.diagnoses || []).map((d: any) => d.code);

      const vitalsObj: Record<string, string> = {};
      for (const obs of note.objective?.observationIds || []) {
        if (obs.code && obs.value) {
          vitalsObj[obs.code] = `${obs.value} ${obs.unit || ""}`.trim();
        }
      }

      const prescriptions = (note.plan?.prescriptionIds || []).map((p: any) => ({
        name: p.medicineName || "Medication",
        dosage: p.dosage || "",
        duration: p.duration || "",
      }));

      events.push({
        id: note._id.toString(),
        type: "consultation",
        occurredAt: note.signature?.signedAt || note.createdAt,
        patientId: query.patientId,
        organizationId: query.organizationId,
        title: diagnoses.length > 0 ? `SOAP Note: ${diagnoses[0]}` : `Clinical Note (v${note.version})`,
        summary: note.subjective?.chiefComplaint ? `Chief Complaint: ${note.subjective.chiefComplaint}` : "Signed SOAP consultation document",
        actor: {
          id: doctorId,
          name: doctorName,
          role: "Doctor",
        },
        sourceRef: {
          source: TimelineSource.OPD,
          resourceType: "Appointment",
          resourceId: note.appointmentId?.toString() || note._id.toString(),
          link: `/dashboard/appointments?id=${note.appointmentId?.toString() || note._id.toString()}`,
        },
        clinicalMetadata: {
          diagnoses,
          symptoms: note.subjective?.symptoms || [],
          medications: prescriptions,
        },
        displayMetadata: {
          icon: "stethoscope",
          badgeColor: "emerald",
          statusLabel: `Signed v${note.version}`,
          uiCategory: "consultation",
        },
        clinicalConcepts: {
          diagnoses: rawDiagCodes,
          medications: prescriptions.map((p: any) => p.name),
          procedures: ["SOAP Clinical Consultation"],
          allergies: [],
          vitals: vitalsObj,
          labCodes: [],
        },
      });
    }

    // 2. Fetch Appointments without a Clinical Note
    const appointments = await Appointment.find({
      patientId: query.patientId,
      status: { $in: ["completed", "in-consultation", "checked-in"] },
    })
      .populate("doctorId", "name email")
      .lean();

    for (const appt of appointments as any[]) {
      if (noteApptIds.has(appt._id.toString())) continue;

      const doctorName = appt.doctorId?.name || "Attending Physician";
      const doctorId = appt.doctorId?._id?.toString() || appt.doctorId?.toString() || "unknown";

      const diagnoses = appt.diagnosis ? [appt.diagnosis] : [];
      const symptoms = appt.symptoms ? [appt.symptoms] : [];
      const prescriptions = appt.prescriptions || [];

      events.push({
        id: appt._id.toString(),
        type: "consultation",
        occurredAt: appt.appointmentTime || appt.createdAt,
        patientId: query.patientId,
        organizationId: query.organizationId,
        title: appt.diagnosis ? `OPD Consultation: ${appt.diagnosis}` : "Outpatient Consultation",
        summary: appt.symptoms ? `Symptoms: ${appt.symptoms}` : "Outpatient clinical consultation completed.",
        actor: {
          id: doctorId,
          name: doctorName,
          role: "Doctor",
        },
        sourceRef: {
          source: TimelineSource.OPD,
          resourceType: "Appointment",
          resourceId: appt._id.toString(),
          link: `/dashboard/appointments?id=${appt._id.toString()}`,
        },
        clinicalMetadata: {
          diagnoses,
          symptoms,
          medications: prescriptions.map((p: any) => ({
            name: p.name,
            dosage: p.dosage,
            duration: p.duration,
          })),
        },
        displayMetadata: {
          icon: "stethoscope",
          badgeColor: "emerald",
          statusLabel: appt.status,
          uiCategory: "consultation",
        },
        clinicalConcepts: {
          diagnoses,
          medications: prescriptions.map((p: any) => p.name),
          procedures: ["OPD Consultation"],
          allergies: [],
          vitals: {},
          labCodes: [],
        },
      });
    }

    return events;
  }
}

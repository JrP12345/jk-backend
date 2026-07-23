import { Admission } from "../../models/Admission.ts";
import { Bed } from "../../models/Bed.ts";
import {
  type TimelineEvent,
  type TimelineProvider,
  type TimelineQueryOptions,
  TimelineSource,
} from "../../types/timeline.ts";

export class AdmissionProvider implements TimelineProvider {
  name = "AdmissionProvider";

  supports(query: TimelineQueryOptions): boolean {
    return !query.category || query.category === "all" || query.category === "admission";
  }

  async fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]> {
    const admissions = await Admission.find({
      patientId: query.patientId,
    })
      .populate("bedId", "bedName ward")
      .populate("doctorInCharge", "name")
      .lean();

    const events: TimelineEvent[] = [];

    for (const adm of admissions as any[]) {
      const bedName = adm.bedId?.bedName || "Unassigned Bed";
      const ward = adm.bedId?.ward || "General Ward";
      const doctorName = adm.doctorInCharge?.name || "Attending Physician";
      const doctorId = adm.doctorInCharge?._id?.toString() || adm.doctorInCharge?.toString() || "unknown";

      const durationDays = adm.dischargeDate
        ? Math.max(1, Math.ceil((new Date(adm.dischargeDate).getTime() - new Date(adm.admissionDate).getTime()) / (1000 * 60 * 60 * 24)))
        : undefined;

      events.push({
        id: adm._id.toString(),
        type: adm.status === "discharged" ? "discharge" : "admission",
        occurredAt: adm.dischargeDate || adm.admissionDate || adm.createdAt,
        patientId: query.patientId,
        organizationId: query.organizationId,
        title: adm.status === "discharged" ? `Discharged from Ward: ${ward}` : `Admitted to Bed: ${bedName} (${ward})`,
        summary: `Reason: ${adm.reasonForAdmission}`,
        actor: {
          id: doctorId,
          name: doctorName,
          role: "Doctor",
        },
        sourceRef: {
          source: TimelineSource.IPD,
          resourceType: "Admission",
          resourceId: adm._id.toString(),
          link: `/dashboard/admissions?id=${adm._id.toString()}`,
        },
        clinicalMetadata: {
          admission: {
            bedName,
            ward,
            durationDays,
            reason: adm.reasonForAdmission,
          },
        },
        displayMetadata: {
          icon: "bed",
          badgeColor: "indigo",
          statusLabel: adm.status,
          uiCategory: "admission",
        },
        clinicalConcepts: {
          diagnoses: [adm.reasonForAdmission],
          medications: [],
          procedures: ["Inpatient Admission"],
          allergies: [],
          vitals: {},
          labCodes: [],
        },
      });
    }

    return events;
  }
}

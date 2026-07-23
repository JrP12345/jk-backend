import { MedicationAdministration } from "../../models/MedicationAdministration.ts";
import { User } from "../../models/User.ts";
import {
  type TimelineEvent,
  type TimelineProvider,
  type TimelineQueryOptions,
  TimelineSource,
} from "../../types/timeline.ts";

/**
 * MARProvider — surfaces MedicationAdministration events into the longitudinal
 * EHR timeline. Only administered, refused, held, and missed entries are shown
 * (scheduled-only entries without an outcome are omitted to keep the timeline
 * meaningful for clinical review).
 *
 * Timeline entry enrichment includes:
 *   - Medicine name, prescribed vs actual dose
 *   - Route of administration
 *   - Status (administered / refused / held / missed)
 *   - Accountable clinician (administeredBy or recordedBy)
 *   - Navigation link back to the MAR record
 */
export class MARProvider implements TimelineProvider {
  name = "MARProvider";

  supports(query: TimelineQueryOptions): boolean {
    return (
      !query.category ||
      query.category === "all" ||
      query.category === "medication_administration"
    );
  }

  async fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]> {
    // Only surface non-scheduled entries — outcomes only
    const administrations = await MedicationAdministration.find({
      patientId: query.patientId,
      organizationId: query.organizationId,
      status: { $in: ["administered", "refused", "held", "missed"] },
    })
      .populate("administeredBy", "name email")
      .populate("recordedBy", "name email")
      .lean();

    const events: TimelineEvent[] = [];

    for (const adm of administrations as any[]) {
      const actorDoc = adm.administeredBy || adm.recordedBy;
      const actorName = actorDoc?.name || "Clinical Staff";
      const actorId = actorDoc?._id?.toString() || actorDoc?.toString() || "unknown";
      const actorRole = adm.administeredBy ? "Nurse/Doctor" : "Recorder";

      // Timeline timestamp: when it happened, or scheduled time as fallback
      const occurredAt =
        adm.administeredTime ||
        adm.createdAt;

      const doseLabel =
        adm.status === "administered" && adm.doseGiven
          ? adm.doseGiven
          : adm.prescribedDose;

      const title = `Medication Administration: ${adm.medicineName} ${doseLabel} (${adm.route})`;

      const summaryByStatus: Record<string, string> = {
        administered: `Dose administered: ${adm.doseGiven || adm.prescribedDose} via ${adm.route}.`,
        refused:      `Patient refused dose. Reason: ${adm.refusalReason || "not recorded"}.`,
        held:         `Dose held by clinician. Reason: ${adm.holdReason || "not recorded"}.`,
        missed:       `Scheduled dose was not administered (missed).`,
      };

      const badgeByStatus: Record<string, string> = {
        administered: "teal",
        refused:      "amber",
        held:         "orange",
        missed:       "red",
      };

      events.push({
        id: adm._id.toString(),
        type: "medication_administration",
        occurredAt,
        patientId: query.patientId,
        organizationId: query.organizationId,
        title,
        summary: summaryByStatus[adm.status] || "Medication administration event.",
        actor: {
          id: actorId,
          name: actorName,
          role: actorRole,
        },
        sourceRef: {
          source: TimelineSource.MAR,
          resourceType: "MedicationAdministration",
          resourceId: adm._id.toString(),
          link: `/dashboard/mar?id=${adm._id.toString()}&encounter=${adm.encounterId?.toString()}`,
        },
        clinicalMetadata: {
          administration: {
            medicineName:     adm.medicineName,
            prescribedDose:   adm.prescribedDose,
            doseGiven:        adm.doseGiven || "",
            route:            adm.route,
            status:           adm.status,
            scheduledTime:    adm.scheduledTime?.toISOString(),
            administeredTime: adm.administeredTime?.toISOString(),
          },
        },
        displayMetadata: {
          icon: "pill",
          badgeColor: badgeByStatus[adm.status] || "gray",
          statusLabel: adm.status.charAt(0).toUpperCase() + adm.status.slice(1),
          uiCategory: "medication_administration",
        },
        clinicalConcepts: {
          diagnoses:  [],
          medications: [adm.medicineName],
          procedures:  ["Medication Administration"],
          allergies:   [],
          vitals:      {},
          labCodes:    [],
        },
      });
    }

    return events;
  }
}

import { DischargeDocument } from "../../models/DischargeDocument.ts";
import { User } from "../../models/User.ts";
import {
  type TimelineEvent,
  type TimelineProvider,
  type TimelineQueryOptions,
  TimelineSource,
} from "../../types/timeline.ts";

/**
 * DischargeSummaryProvider — surfaces finalized & countersigned DischargeDocument
 * artifacts into the longitudinal EHR timeline.
 */
export class DischargeSummaryProvider implements TimelineProvider {
  name = "DischargeSummaryProvider";

  supports(query: TimelineQueryOptions): boolean {
    return (
      !query.category ||
      query.category === "all" ||
      query.category === "discharge"
    );
  }

  async fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]> {
    const documents = await DischargeDocument.find({
      patientId: query.patientId,
      organizationId: query.organizationId,
      status: { $in: ["finalized", "countersigned"] },
    })
      .populate("authoredBy", "name email")
      .populate("countersignedBy", "name email")
      .lean();

    const events: TimelineEvent[] = [];

    for (const doc of documents as any[]) {
      const authorDoc = doc.authoredBy;
      const authorName = authorDoc?.name || "Attending Physician";
      const authorId = authorDoc?._id?.toString() || authorDoc?.toString() || "unknown";

      const primaryDiag = doc.clinicianInput?.primaryDiagnosis || "Encounter Discharge";
      const condition = doc.clinicianInput?.conditionOnDischarge || "Discharged";

      events.push({
        id: doc._id.toString(),
        type: "discharge_summary",
        occurredAt: doc.finalizedAt || doc.createdAt,
        patientId: query.patientId,
        organizationId: query.organizationId,
        title: `Discharge Summary: ${primaryDiag}`,
        summary: `Condition on discharge: ${condition}. Document finalized by ${authorName}.`,
        actor: {
          id: authorId,
          name: authorName,
          role: "Doctor",
        },
        sourceRef: {
          source: TimelineSource.DISCHARGE,
          resourceType: "DischargeDocument",
          resourceId: doc._id.toString(),
          link: `/dashboard/discharge?id=${doc._id.toString()}&encounter=${doc.encounterId?.toString()}`,
        },
        clinicalMetadata: {
          discharge: {
            primaryDiagnosis: primaryDiag,
            conditionOnDischarge: condition,
            finalizedAt: doc.finalizedAt ? doc.finalizedAt.toISOString() : "",
            snapshotHash: doc.snapshotHash || "",
          },
        },
        displayMetadata: {
          icon: "document-text",
          badgeColor: "purple",
          statusLabel: doc.status === "countersigned" ? "Countersigned" : "Finalized",
          uiCategory: "discharge",
        },
        clinicalConcepts: {
          diagnoses: primaryDiag ? [primaryDiag] : [],
          medications: (doc.aggregated?.medications || []).map((m: any) => m.medicineName),
          procedures: doc.aggregated?.procedures || [],
          allergies: [],
          vitals: doc.aggregated?.vitalsOnDischarge?.vitals || {},
          labCodes: (doc.aggregated?.labResults || []).map((l: any) => l.testCode || l.testName),
        },
      });
    }

    return events;
  }
}

import { DocumentUpload } from "../../models/DocumentUpload.ts";
import {
  type TimelineEvent,
  type TimelineProvider,
  type TimelineQueryOptions,
  TimelineSource,
} from "../../types/timeline.ts";

export class DocumentUploadProvider implements TimelineProvider {
  name = "DocumentUploadProvider";

  supports(query: TimelineQueryOptions): boolean {
    return !query.category || query.category === "all" || query.category === "documents" || query.category === "lab";
  }

  async fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]> {
    const docs = await DocumentUpload.find({
      patientId: query.patientId,
    })
      .populate("uploadedByUserId", "name role")
      .lean();

    const events: TimelineEvent[] = [];

    for (const doc of docs as any[]) {
      const uploaderName = doc.uploadedByUserId?.name || "Patient / Caregiver";
      const uploaderRole = doc.uploadedByUserId?.role || "patient";

      events.push({
        id: `DOCUMENT_${doc._id.toString()}`,
        type: "DOCUMENT_UPLOAD",
        occurredAt: doc.uploadedAt || doc.createdAt || new Date(),
        patientId: doc.patientId.toString(),
        organizationId: doc.organizationId ? doc.organizationId.toString() : query.organizationId,
        title: `Medical Document: ${doc.fileName}`,
        summary: `Uploaded ${doc.category} report (${doc.fileName}). OCR Status: ${doc.ocrStatus.toUpperCase()}.`,
        actor: {
          id: doc.uploadedByUserId?._id?.toString() || "patient",
          name: uploaderName,
          role: uploaderRole,
        },
        sourceRef: {
          source: TimelineSource.DOCUMENT_UPLOAD,
          resourceType: "DocumentUpload",
          resourceId: doc._id.toString(),
          link: doc.fileUrl,
        },
        clinicalMetadata: {
          diagnoses: doc.extractedConcepts?.diagnoses || [],
          medications: (doc.extractedConcepts?.medications || []).map((m: string) => ({
            name: m,
            dosage: "Unspecified",
            duration: "Unspecified",
          })),
        },
        displayMetadata: {
          icon: "FileText",
          badgeColor: "blue",
          statusLabel: doc.ocrStatus.toUpperCase(),
          uiCategory: "lab",
        },
        clinicalConcepts: {
          diagnoses: doc.extractedConcepts?.diagnoses || [],
          medications: doc.extractedConcepts?.medications || [],
          procedures: [],
          allergies: [],
          vitals: {},
          labCodes: doc.extractedConcepts?.labCodes || [],
        },
      });
    }

    return events;
  }
}

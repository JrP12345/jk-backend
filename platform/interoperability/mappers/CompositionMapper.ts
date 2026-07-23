import type { FHIRComposition } from "../types.ts";
import { CodeSystems } from "../TerminologyResolver.ts";

export class CompositionMapper {
  public static toFHIR(doc: any): FHIRComposition {
    const docId = doc._id?.toString() || doc.id?.toString() || "unknown";
    const patientId = doc.patientId?._id?.toString() || doc.patientId?.toString() || "unknown";
    const encounterId = doc.encounterId?._id?.toString() || doc.encounterId?.toString();
    const authorId = doc.authoredBy?._id?.toString() || doc.authoredBy?.toString() || "unknown";

    const primaryDiag = doc.clinicianInput?.primaryDiagnosis || "Discharge Summary";

    let fhirStatus: FHIRComposition["status"] = "preliminary";
    if (doc.status === "finalized" || doc.status === "countersigned") {
      fhirStatus = "final";
    }

    const extensions: any[] = [];
    if (doc.snapshotHash) {
      extensions.push({
        url: "http://healthos.org/fhir/StructureDefinition/snapshot-hash",
        valueString: doc.snapshotHash,
      });
    }

    return {
      resourceType: "Composition",
      id: docId,
      status: fhirStatus,
      type: {
        coding: [
          {
            system: CodeSystems.LOINC,
            code: "18842-5",
            display: "Discharge summary",
          },
        ],
        text: "Discharge summary",
      },
      subject: {
        reference: `Patient/${patientId}`,
      },
      ...(encounterId ? { encounter: { reference: `Encounter/${encounterId}` } } : {}),
      date: doc.finalizedAt ? new Date(doc.finalizedAt).toISOString() : new Date(doc.createdAt).toISOString(),
      author: [
        {
          reference: `Practitioner/${authorId}`,
          display: doc.authoredBy?.name || "Attending Physician",
        },
      ],
      title: `Discharge Summary: ${primaryDiag}`,
      ...(extensions.length > 0 ? { extension: extensions } : {}),
      section: [
        {
          title: "Chief Diagnosis & Condition on Discharge",
          text: {
            status: "generated",
            div: `<div><p><b>Primary Diagnosis:</b> ${primaryDiag}</p><p><b>Condition:</b> ${doc.clinicianInput?.conditionOnDischarge || "Discharged"}</p></div>`,
          },
        },
        {
          title: "Discharge Instructions & Follow-up Plan",
          text: {
            status: "generated",
            div: `<div><p><b>Instructions:</b> ${doc.clinicianInput?.dischargeInstructions || "None"}</p><p><b>Follow-up:</b> ${doc.clinicianInput?.followUpPlan || "As needed"}</p></div>`,
          },
        },
      ],
    };
  }
}

import type { FHIREncounter } from "../types.ts";
import { TerminologyResolver } from "../TerminologyResolver.ts";

export class EncounterMapper {
  public static toFHIR(encounter: any): FHIREncounter {
    const encId = encounter._id?.toString() || encounter.id?.toString() || "unknown";
    const patientId = encounter.patientId?._id?.toString() || encounter.patientId?.toString() || "unknown";

    let fhirStatus: FHIREncounter["status"] = "in-progress";
    if (encounter.status === "completed" || encounter.status === "closed") {
      fhirStatus = "finished";
    } else if (encounter.status === "cancelled") {
      fhirStatus = "cancelled";
    } else if (encounter.status === "scheduled") {
      fhirStatus = "planned";
    }

    return {
      resourceType: "Encounter",
      id: encId,
      status: fhirStatus,
      class: TerminologyResolver.resolveEncounterClass(encounter.encounterType),
      subject: {
        reference: `Patient/${patientId}`,
      },
      period: {
        start: encounter.startedAt ? new Date(encounter.startedAt).toISOString() : undefined,
        end: encounter.endedAt ? new Date(encounter.endedAt).toISOString() : undefined,
      },
    };
  }
}

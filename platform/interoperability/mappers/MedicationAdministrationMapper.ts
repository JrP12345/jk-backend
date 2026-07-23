import type { FHIRMedicationAdministration } from "../types.ts";
import { TerminologyResolver, CodeSystems } from "../TerminologyResolver.ts";

export class MedicationAdministrationMapper {
  public static toFHIR(mar: any): FHIRMedicationAdministration {
    const marId = mar._id?.toString() || mar.id?.toString() || "unknown";
    const patientId = mar.patientId?._id?.toString() || mar.patientId?.toString() || "unknown";
    const encounterId = mar.encounterId?._id?.toString() || mar.encounterId?.toString();

    let fhirStatus: FHIRMedicationAdministration["status"] = "in-progress";
    if (mar.status === "administered") {
      fhirStatus = "completed";
    } else if (mar.status === "refused") {
      fhirStatus = "not-done";
    } else if (mar.status === "held") {
      fhirStatus = "on-hold";
    } else if (mar.status === "missed") {
      fhirStatus = "stopped";
    }

    const doseStr = mar.doseGiven || mar.prescribedDose || "";

    return {
      resourceType: "MedicationAdministration",
      id: marId,
      status: fhirStatus,
      medicationCodeableConcept: {
        coding: [
          {
            system: CodeSystems.RxNorm,
            code: "MED",
            display: mar.medicineName || "Medication",
          },
        ],
        text: mar.medicineName || "Medication",
      },
      subject: {
        reference: `Patient/${patientId}`,
      },
      ...(encounterId ? { context: { reference: `Encounter/${encounterId}` } } : {}),
      effectiveDateTime: mar.administeredTime
        ? new Date(mar.administeredTime).toISOString()
        : mar.scheduledTime
        ? new Date(mar.scheduledTime).toISOString()
        : new Date().toISOString(),
      dosage: {
        text: doseStr,
        route: TerminologyResolver.resolveRouteCoding(mar.route),
      },
    };
  }
}

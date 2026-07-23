import type { FHIRObservation } from "../types.ts";
import { TerminologyResolver, CodeSystems } from "../TerminologyResolver.ts";

export class ObservationMapper {
  public static toFHIR(obs: any): FHIRObservation {
    const obsId = obs._id?.toString() || obs.id?.toString() || "unknown";
    const patientId = obs.patientId?._id?.toString() || obs.patientId?.toString() || "unknown";
    const encounterId = obs.encounterId?._id?.toString() || obs.encounterId?.toString();

    const numericVal = parseFloat(obs.value);
    const hasNumeric = !isNaN(numericVal);

    return {
      resourceType: "Observation",
      id: obsId,
      status: "final",
      category: [
        {
          coding: [
            {
              system: CodeSystems.OBSERVATION_CATEGORY,
              code: "vital-signs",
              display: "Vital Signs",
            },
          ],
          text: "Vital Signs",
        },
      ],
      code: TerminologyResolver.resolveVitalCoding(obs.code, obs.name),
      subject: {
        reference: `Patient/${patientId}`,
      },
      ...(encounterId ? { encounter: { reference: `Encounter/${encounterId}` } } : {}),
      effectiveDateTime: obs.recordedAt ? new Date(obs.recordedAt).toISOString() : new Date().toISOString(),
      ...(hasNumeric
        ? { valueQuantity: { value: numericVal, unit: obs.unit || "", system: CodeSystems.LOINC } }
        : { valueString: `${obs.value}${obs.unit ? " " + obs.unit : ""}` }),
    };
  }
}

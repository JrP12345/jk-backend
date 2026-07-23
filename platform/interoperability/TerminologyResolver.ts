import type { FHIRCoding, FHIRCodeableConcept } from "./types.ts";

export const CodeSystems = {
  LOINC: "http://loinc.org",
  SNOMED_CT: "http://snomed.info/sct",
  RxNorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  ICD10: "http://hl7.org/fhir/sid/icd-10",
  FHIR_V3_ACT_CODE: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
  OBSERVATION_CATEGORY: "http://terminology.hl7.org/CodeSystem/observation-category",
} as const;

export class TerminologyResolver {
  /**
   * Maps internal vital observation codes to standard LOINC codings.
   */
  public static resolveVitalCoding(code: string, name: string): FHIRCodeableConcept {
    const normCode = (code || "").toUpperCase();
    let loincCode = "8867-4"; // default
    let display = name || code || "Vital Sign";

    switch (normCode) {
      case "SPO2":
        loincCode = "59408-5";
        display = "Oxygen saturation in Arterial blood by Pulse oximetry";
        break;
      case "BP":
      case "BLOOD_PRESSURE":
        loincCode = "85354-9";
        display = "Blood pressure panel with all children optional";
        break;
      case "HR":
      case "HEART_RATE":
        loincCode = "8867-4";
        display = "Heart rate";
        break;
      case "RR":
      case "RESPIRATORY_RATE":
        loincCode = "9279-1";
        display = "Respiratory rate";
        break;
      case "TEMP":
      case "TEMPERATURE":
        loincCode = "8310-5";
        display = "Body temperature";
        break;
      default:
        loincCode = "8867-4";
    }

    return {
      coding: [
        {
          system: CodeSystems.LOINC,
          code: loincCode,
          display,
        },
      ],
      text: display,
    };
  }

  /**
   * Maps internal encounter types to FHIR v3 ActCode classes.
   */
  public static resolveEncounterClass(encounterType: string): FHIRCoding {
    const norm = (encounterType || "").toLowerCase();
    switch (norm) {
      case "ipd":
        return { system: CodeSystems.FHIR_V3_ACT_CODE, code: "IMP", display: "inpatient encounter" };
      case "emergency":
        return { system: CodeSystems.FHIR_V3_ACT_CODE, code: "EMER", display: "emergency" };
      case "telehealth":
        return { system: CodeSystems.FHIR_V3_ACT_CODE, code: "VR", display: "virtual" };
      case "opd":
      default:
        return { system: CodeSystems.FHIR_V3_ACT_CODE, code: "AMB", display: "ambulatory" };
    }
  }

  /**
   * Maps medication administration routes to SNOMED CT codes.
   */
  public static resolveRouteCoding(route: string): FHIRCodeableConcept {
    const norm = (route || "").toLowerCase();
    let code = "260548002"; // default oral
    let display = route || "Oral route";

    switch (norm) {
      case "iv":
        code = "47625008";
        display = "Intravenous route";
        break;
      case "im":
        code = "78421000";
        display = "Intramuscular route";
        break;
      case "sublingual":
        code = "372470008";
        display = "Sublingual route";
        break;
      case "topical":
        code = "6064005";
        display = "Topical route";
        break;
      case "oral":
      default:
        code = "260548002";
        display = "Oral route";
    }

    return {
      coding: [{ system: CodeSystems.SNOMED_CT, code, display }],
      text: display,
    };
  }
}

/**
 * Standard FHIR R4 Coding & CodeableConcept structures.
 */
export interface FHIRCoding {
  system: string;
  code: string;
  display: string;
}

export interface FHIRCodeableConcept {
  coding: FHIRCoding[];
  text?: string;
}

export interface FHIRPeriod {
  start?: string;
  end?: string;
}

export interface FHIRReference {
  reference: string;
  display?: string;
}

/**
 * Base FHIR R4 Resource Envelope.
 */
export interface FHIRResource {
  resourceType: string;
  id: string;
  meta?: {
    versionId?: string;
    lastUpdated?: string;
    profile?: string[];
  };
  extension?: Array<{
    url: string;
    valueString?: string;
    valueBoolean?: boolean;
    valueDateTime?: string;
  }>;
}

export interface FHIRPatient extends FHIRResource {
  resourceType: "Patient";
  active: boolean;
  name: Array<{ family: string; given: string[]; text: string }>;
  telecom: Array<{ system: "phone" | "email"; value: string }>;
  gender?: "male" | "female" | "other" | "unknown";
  birthDate?: string;
}

export interface FHIREncounter extends FHIRResource {
  resourceType: "Encounter";
  status: "planned" | "arrived" | "triaged" | "in-progress" | "onleave" | "finished" | "cancelled";
  class: FHIRCoding;
  subject: FHIRReference; // Patient/{id}
  period: FHIRPeriod;
}

export interface FHIRObservation extends FHIRResource {
  resourceType: "Observation";
  status: "registered" | "preliminary" | "final" | "amended";
  category?: FHIRCodeableConcept[];
  code: FHIRCodeableConcept;
  subject: FHIRReference; // Patient/{id}
  encounter?: FHIRReference; // Encounter/{id}
  effectiveDateTime?: string;
  valueQuantity?: { value: number; unit: string; system?: string; code?: string };
  valueString?: string;
}

export interface FHIRDiagnosticReport extends FHIRResource {
  resourceType: "DiagnosticReport";
  status: "registered" | "partial" | "preliminary" | "final";
  code: FHIRCodeableConcept;
  subject: FHIRReference; // Patient/{id}
  encounter?: FHIRReference; // Encounter/{id}
  effectiveDateTime?: string;
  issued?: string;
  conclusion?: string;
  result?: FHIRReference[]; // Observation references
}

export interface FHIRMedicationAdministration extends FHIRResource {
  resourceType: "MedicationAdministration";
  status: "in-progress" | "not-done" | "on-hold" | "completed" | "entered-in-error" | "stopped";
  medicationCodeableConcept: FHIRCodeableConcept;
  subject: FHIRReference; // Patient/{id}
  context?: FHIRReference; // Encounter/{id}
  effectiveDateTime?: string;
  dosage?: {
    text: string;
    route?: FHIRCodeableConcept;
    dose?: { value: number; unit: string };
  };
}

export interface FHIRCompositionSection {
  title: string;
  code?: FHIRCodeableConcept;
  text?: { status: "generated" | "extensions" | "additional"; div: string };
  entry?: FHIRReference[];
}

export interface FHIRComposition extends FHIRResource {
  resourceType: "Composition";
  status: "preliminary" | "final" | "amended" | "entered-in-error";
  type: FHIRCodeableConcept;
  subject: FHIRReference; // Patient/{id}
  encounter?: FHIRReference; // Encounter/{id}
  date: string;
  author: FHIRReference[];
  title: string;
  section: FHIRCompositionSection[];
}

export interface FHIRBundleEntry {
  fullUrl?: string;
  resource: FHIRResource;
}

export interface FHIRBundle extends FHIRResource {
  resourceType: "Bundle";
  type: "document" | "collection" | "transaction" | "message";
  timestamp?: string;
  total?: number;
  entry: FHIRBundleEntry[];
}

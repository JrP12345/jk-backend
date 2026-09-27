/**
 * Domain Event Taxonomy Event Type Constants
 */
export const EventTypes = {
  ENCOUNTER_STARTED: "EncounterStarted",
  OBSERVATION_RECORDED: "ObservationRecorded",
  NEWS2_EVALUATED: "NEWS2Evaluated",
  PRESCRIPTION_CREATED: "PrescriptionCreated",
  MEDICATION_ADMINISTERED: "MedicationAdministered",
  ORDER_PLACED: "OrderPlaced",
  RESULT_UPLOADED: "ResultUploaded",
  DISCHARGE_FINALIZED: "DischargeFinalized",
} as const;

export interface OrderPlacedPayload {
  orderId: string;
  encounterId?: string;
  patientId: string;
  testId: string;
  priority: string;
  orderedBy: string;
}

export interface ResultUploadedPayload {
  orderId: string;
  encounterId?: string;
  patientId: string;
  testCode: string;
  testName: string;
  value: string;
  unit: string;
  referenceRange: string;
  interpretation: string;
  isAbnormal: boolean;
  resultedBy: string;
}

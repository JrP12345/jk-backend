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

export type EventType = typeof EventTypes[keyof typeof EventTypes];

// ─── Serialization-friendly Event Payloads ─────────────────────────────────

export interface EncounterStartedPayload {
  encounterId: string;
  patientId: string;
  organizationId: string;
  clinicId: string;
  encounterType: string;
  startedAt: string;
}

export interface ObservationRecordedPayload {
  observationId: string;
  encounterId: string;
  patientId: string;
  organizationId: string;
  clinicId: string;
  code: string;
  name: string;
  value: string;
  unit: string;
}

export interface NEWS2EvaluatedPayload {
  scoreId: string;
  encounterId: string;
  patientId: string;
  totalScore: number;
  riskCategory: string;
  evaluatedAt: string;
}

export interface PrescriptionCreatedPayload {
  prescriptionId: string;
  encounterId: string;
  patientId: string;
  medicineName: string;
  dosage: string;
  frequency: string;
}

export interface MedicationAdministeredPayload {
  administrationId: string;
  prescriptionId: string;
  encounterId: string;
  patientId: string;
  medicineName: string;
  prescribedDose: string;
  doseGiven: string;
  route: string;
  status: "administered" | "refused" | "held" | "missed";
  administeredBy?: string;
  recordedBy: string;
}

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

export interface DischargeFinalizedPayload {
  dischargeId: string;
  encounterId: string;
  patientId: string;
  primaryDiagnosis: string;
  conditionOnDischarge: string;
  snapshotHash: string;
  finalizedAt: string;
  authoredBy: string;
}

export const TimelineSource = {
  OPD: "OPD",
  LAB: "LAB",
  IPD: "IPD",
  BILLING: "BILLING",
  PRESCRIPTION: "PRESCRIPTION",
  MAR: "MAR",
  DISCHARGE: "DISCHARGE"
} as const;

export type TimelineSource = typeof TimelineSource[keyof typeof TimelineSource];

export interface TimelineActor {
  id: string;
  name: string;
  role?: string;
}

export interface TimelineSourceRef {
  source: TimelineSource;
  resourceType: "Appointment" | "LabOrder" | "Admission" | "Invoice" | "MedicationAdministration" | "DischargeDocument";
  resourceId: string;
  link: string;
}

export interface ClinicalMetadata {
  diagnoses?: string[];
  symptoms?: string[];
  medications?: Array<{ name: string; dosage: string; duration: string }>;
  labValues?: Array<{ testName: string; value: string; notes?: string; attachmentUrl?: string }>;
  admission?: { bedName?: string; ward?: string; durationDays?: number; reason?: string };
  billing?: { totalAmount: number; paymentStatus: string; paidAt?: string };
  administration?: {
    medicineName: string;
    prescribedDose: string;
    doseGiven: string;
    route: string;
    status: string;
    scheduledTime?: string;
    administeredTime?: string;
  };
  discharge?: {
    primaryDiagnosis: string;
    conditionOnDischarge: string;
    finalizedAt: string;
    snapshotHash: string;
  };
}

export interface DisplayMetadata {
  icon: string;
  badgeColor: string;
  statusLabel: string;
  uiCategory: "consultation" | "lab" | "admission" | "billing" | "medication_administration" | "discharge";
}

export interface ClinicalConcepts {
  diagnoses: string[];
  medications: string[];
  procedures: string[];
  allergies: string[];
  vitals: Record<string, any>;
  labCodes: string[];
}

export interface TimelineEvent {
  id: string;
  type: string;
  occurredAt: Date;
  patientId: string;
  organizationId: string;
  title: string;
  summary: string;
  actor: TimelineActor;
  sourceRef: TimelineSourceRef;
  clinicalMetadata: ClinicalMetadata;
  displayMetadata: DisplayMetadata;
  clinicalConcepts: ClinicalConcepts;
}

export interface TimelineQueryOptions {
  patientId: string;
  organizationId: string;
  category?: string;
  includeFinancial?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface TimelineProvider {
  name: string;
  supports(query: TimelineQueryOptions): boolean;
  fetch(query: TimelineQueryOptions): Promise<TimelineEvent[]>;
}

export interface TimelineQueryResponse {
  version: 1;
  events: TimelineEvent[];
  nextCursor: string | null;
  hasMore: boolean;
  returnedCount: number;
  totalCount: number;
  metrics: {
    durationMs: number;
    providerExecutionTimesMs: Record<string, number>;
  };
}

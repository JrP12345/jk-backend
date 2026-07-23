export type SeverityLevel = "critical" | "major" | "moderate" | "minor" | "informational";
export type SystemAction = "hard_stop" | "override_required" | "warning" | "informational";

export interface CDSContext {
  patient: {
    id: string;
    dob?: Date;
    gender?: string;
    allergies: string[];
    conditions: string[];
  };
  activeMedications: Array<{ medicineName: string; medicineId?: string }>;
  proposedPrescriptions: Array<{ medicineName: string; medicineId?: string; dosage?: string; frequency?: string }>;
  observations?: Array<{ code: string; value: string; unit?: string }>;
}

export interface SafetyFinding {
  id: string;
  ruleId: string;
  findingType: "allergy" | "interaction" | "duplicate_therapy" | "dose_limit" | "monitoring_recommendation";
  severity: SeverityLevel;
  systemAction: SystemAction;
  title: string;
  description: string;
  evidence: string;
  recommendation: string;
  offendingItems: string[];
}

export interface SafetyEvaluationResult {
  evaluatedAt: Date;
  engineVersion: string;
  terminologyVersion: string;
  datasetVersion: string;
  findings: SafetyFinding[];
  hasHardStop: boolean;
  hasOverrideRequired: boolean;
  metrics: {
    durationMs: number;
    rulesExecuted: number;
    findingsCount: number;
  };
}

export interface SafetyRule {
  ruleId: string;
  name: string;
  version: string;
  category: "ALLERGY" | "DRUG_INTERACTION" | "DUPLICATE_THERAPY";
  enabled: boolean;
  evaluate(context: CDSContext): Promise<SafetyFinding[]>;
}

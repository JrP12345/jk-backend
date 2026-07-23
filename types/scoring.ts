export interface ParameterSubScore {
  parameter: string;
  rawValue: string | number;
  normalizedValue: string | number;
  unit: string;
  subScore: number;
}

export interface ScoringResult {
  algorithmId: string;
  algorithmVersion: string;
  totalScore: number;
  riskCategory: "Low" | "Low-Medium" | "Medium" | "High";
  isComplete: boolean;
  missingParameters: string[];
  parameterBreakdown: ParameterSubScore[];
  observationIds: string[];
  evaluatedAt: Date;
}

export interface ClinicalScoringAlgorithm {
  id: string;
  name: string;
  version: string;
  evaluate(observations: Array<{ id?: string; code: string; value: any; unit?: string }>): ScoringResult;
}

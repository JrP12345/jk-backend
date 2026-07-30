export interface PecEvaluationRequest {
  policyStartDate: string; // YYYY-MM-DD
  diagnosisCode: string;   // ICD-10 code e.g. "I10", "E11"
  diagnosisDate?: string;  // YYYY-MM-DD
  customWaitingPeriodMonths?: number;
}

export interface PecEvaluationResult {
  diagnosisCode: string;
  isPecCondition: boolean;
  standardWaitingPeriodMonths: number;
  monthsElapsedSincePolicyStart: number;
  isCovered: boolean;
  exclusionClauseReason?: string;
}

const KNOWN_PEC_DIAGNOSES: Record<string, { name: string; waitingMonths: number }> = {
  I10: { name: "Essential Hypertension", waitingMonths: 24 },
  E11: { name: "Type 2 Diabetes Mellitus", waitingMonths: 24 },
  H25: { name: "Senile Cataract", waitingMonths: 24 },
  K40: { name: "Inguinal Hernia", waitingMonths: 24 },
  M16: { name: "Osteoarthritis of Hip", waitingMonths: 36 },
  M17: { name: "Osteoarthritis of Knee", waitingMonths: 36 },
  C50: { name: "Malignant Neoplasm of Breast", waitingMonths: 48 },
};

export function evaluatePecCondition(request: PecEvaluationRequest): PecEvaluationResult {
  const policyStart = new Date(request.policyStartDate);
  const diagDate = request.diagnosisDate ? new Date(request.diagnosisDate) : new Date();

  const diffTime = Math.max(0, diagDate.getTime() - policyStart.getTime());
  const monthsElapsed = Math.floor(diffTime / (1000 * 3600 * 24 * 30.4375));

  const cleanCode = request.diagnosisCode.trim().toUpperCase();
  const pecRule = KNOWN_PEC_DIAGNOSES[cleanCode];

  const requiredWaitingMonths = request.customWaitingPeriodMonths || (pecRule ? pecRule.waitingMonths : 24);
  const isPecCondition = !!pecRule;

  if (isPecCondition && monthsElapsed < requiredWaitingMonths) {
    return {
      diagnosisCode: cleanCode,
      isPecCondition: true,
      standardWaitingPeriodMonths: requiredWaitingMonths,
      monthsElapsedSincePolicyStart: monthsElapsed,
      isCovered: false,
      exclusionClauseReason: `Claim rejected under Pre-Existing Condition (PEC) clause. Policy active for ${monthsElapsed} months, required waiting period is ${requiredWaitingMonths} months for ${pecRule.name}.`,
    };
  }

  return {
    diagnosisCode: cleanCode,
    isPecCondition,
    standardWaitingPeriodMonths: requiredWaitingMonths,
    monthsElapsedSincePolicyStart: monthsElapsed,
    isCovered: true,
  };
}

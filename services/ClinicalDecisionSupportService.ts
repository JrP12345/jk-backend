import { Patient } from "../models/Patient.ts";

export interface PrescribedMed {
  name: string;
  dosage?: string;
}

export interface CdsAlert {
  severity: "critical" | "warning" | "info";
  title: string;
  description: string;
  recommendation: string;
}

const DRUG_INTERACTION_RULES = [
  {
    drugs: ["warfarin", "aspirin"],
    severity: "critical" as const,
    title: "Major Bleeding Risk (Warfarin + Aspirin)",
    description: "Concurrent use of Warfarin and Aspirin significantly increases the risk of severe gastrointestinal and systemic hemorrhage.",
    recommendation: "Avoid co-administration unless specifically indicated for cardiac prosthetic valves under close INR monitoring.",
  },
  {
    drugs: ["metformin", "contrast"],
    severity: "warning" as const,
    title: "Contrast-Induced Nephropathy / Lactic Acidosis Risk",
    description: "Metformin combined with iodinated radiocontrast agents can trigger acute renal failure and metformin-associated lactic acidosis.",
    recommendation: "Withhold Metformin 48 hours prior to and after contrast administration until renal function is re-evaluated.",
  },
  {
    drugs: ["enalapril", "potassium"],
    severity: "warning" as const,
    title: "Hyperkalemia Risk (ACE Inhibitor + Potassium)",
    description: "ACE inhibitors reduce aldosterone production, leading to serum potassium retention when taken with potassium supplements.",
    recommendation: "Monitor serum potassium levels regularly.",
  },
  {
    drugs: ["sildenafil", "nitroglycerin"],
    severity: "critical" as const,
    title: "Severe Hypotension Risk (PDE5 Inhibitor + Nitrate)",
    description: "Co-administration causes potentiation of vasodilatory effects leading to profound refractory hypotension and myocardial infarction.",
    recommendation: "ABSOLUTELY CONTRAINDICATED. Do not administer nitrates within 24 hours of Sildenafil.",
  },
];

export async function evaluateClinicalDecisionSupport(
  patientId: string,
  prescribedMeds: PrescribedMed[]
): Promise<CdsAlert[]> {
  const alerts: CdsAlert[] = [];

  if (!prescribedMeds || prescribedMeds.length === 0) return alerts;

  const medNames = prescribedMeds.map((m) => m.name.toLowerCase());

  // 1. Drug-Drug Interaction Check
  DRUG_INTERACTION_RULES.forEach((rule) => {
    const matchCount = rule.drugs.filter((d) => medNames.some((m) => m.includes(d))).length;
    if (matchCount >= 2) {
      alerts.push({
        severity: rule.severity,
        title: rule.title,
        description: rule.description,
        recommendation: rule.recommendation,
      });
    }
  });

  // 2. Patient Allergy Cross-Reaction Check
  if (patientId) {
    try {
      const patient = await Patient.findById(patientId);
      if (patient && patient.allergies && patient.allergies.length > 0) {
        patient.allergies.forEach((allergy: string) => {
          const cleanAllergy = allergy.toLowerCase().trim();
          medNames.forEach((med) => {
            if (med.includes(cleanAllergy) || (cleanAllergy.includes("penicillin") && (med.includes("amoxicillin") || med.includes("ampicillin")))) {
              alerts.push({
                severity: "critical",
                title: `Known Patient Allergy Alert: ${allergy.toUpperCase()}`,
                description: `Patient has a documented allergy to '${allergy}'. Prescribed medication '${med}' may trigger anaphylaxis or severe hypersensitivity.`,
                recommendation: "Select an alternative non-cross-reactive antimicrobial or drug class.",
              });
            }
          });
        });
      }
    } catch {
      // Non-critical fallback
    }
  }

  return alerts;
}

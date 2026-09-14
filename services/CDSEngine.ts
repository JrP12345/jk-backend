import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CDSContext,
  SafetyEvaluationResult,
  SafetyFinding,
  SafetyRule,
  SeverityLevel,
  SystemAction,
} from "../types/cds.ts";
import { ClinicalTerminologyService } from "./ClinicalTerminologyService.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATASET_PATH = path.resolve(__dirname, "../data/interactions.json");

// System Policy Mapper: Maps clinical severity to system action workflow
function mapSeverityToSystemAction(severity: SeverityLevel): SystemAction {
  switch (severity) {
    case "critical":
      return "override_required";
    case "major":
      return "override_required";
    case "moderate":
      return "warning";
    case "minor":
      return "informational";
    default:
      return "informational";
  }
}

// ─── Rule 1: Allergy Cross-Referencing ─────────────────────────────────────
export class AllergyRule implements SafetyRule {
  ruleId = "ALLERGY-001";
  name = "Patient Allergy Cross-Reference Rule";
  version = "1.0.0";
  category = "ALLERGY" as const;
  enabled = true;

  async evaluate(context: CDSContext): Promise<SafetyFinding[]> {
    const findings: SafetyFinding[] = [];
    const allergies = context.patient.allergies || [];
    if (allergies.length === 0) return findings;

    for (const proposed of context.proposedPrescriptions) {
      for (const allergy of allergies) {
        if (ClinicalTerminologyService.isAllergicMatch(allergy, proposed.medicineName)) {
          findings.push({
            id: `ALLERGY_${proposed.medicineName}_${allergy}`,
            ruleId: this.ruleId,
            findingType: "allergy",
            severity: "critical",
            systemAction: mapSeverityToSystemAction("critical"),
            title: `Known Patient Allergy Warning: ${proposed.medicineName}`,
            description: `Patient has documented allergy '${allergy}' which cross-reacts with proposed medication '${proposed.medicineName}'.`,
            evidence: `Patient Documented Allergy Registry & Clinical Terminology Matching.`,
            recommendation: `Discontinue '${proposed.medicineName}' and select a non-allergenic alternative drug class.`,
            offendingItems: [proposed.medicineName, allergy],
          });
        }
      }
    }

    return findings;
  }
}

// ─── Rule 2: Externalized Drug-Drug Interaction Rule ──────────────────────
export class DrugInteractionRule implements SafetyRule {
  ruleId = "DRUG-INTERACTION-001";
  name = "Drug-Drug Interaction Rule Engine";
  version = "2026.09.08";
  category = "DRUG_INTERACTION" as const;
  enabled = true;

  private interactionRules: any[] = [];
  public datasetVersion = "2026.09.08";

  constructor() {
    try {
      if (fs.existsSync(DATASET_PATH)) {
        const raw = JSON.parse(fs.readFileSync(DATASET_PATH, "utf8"));
        this.datasetVersion = raw.datasetVersion || "2026.09.08";
        this.version = this.datasetVersion;
        this.interactionRules = raw.rules || [];
      }
    } catch (err) {
      console.error("Failed to load interactions.json:", err);
    }
  }

  async evaluate(context: CDSContext): Promise<SafetyFinding[]> {
    const findings: SafetyFinding[] = [];

    // Combine active medications and proposed prescriptions
    const allMeds = [
      ...context.activeMedications.map((m) => m.medicineName),
      ...context.proposedPrescriptions.map((m) => m.medicineName),
    ];

    const normalizedMeds = allMeds.map((name) => ({
      original: name,
      ingredient: ClinicalTerminologyService.normalizeIngredient(name),
    }));

    for (let i = 0; i < normalizedMeds.length; i++) {
      for (let j = i + 1; j < normalizedMeds.length; j++) {
        const medA = normalizedMeds[i];
        const medB = normalizedMeds[j];

        for (const rule of this.interactionRules) {
          const matchA = medA.ingredient.includes(rule.ingredientA) || rule.ingredientA.includes(medA.ingredient);
          const matchB = medB.ingredient.includes(rule.ingredientB) || rule.ingredientB.includes(medB.ingredient);
          const revMatchA = medB.ingredient.includes(rule.ingredientA) || rule.ingredientA.includes(medB.ingredient);
          const revMatchB = medA.ingredient.includes(rule.ingredientB) || rule.ingredientB.includes(medA.ingredient);

          if ((matchA && matchB) || (revMatchA && revMatchB)) {
            const severity: SeverityLevel = rule.severity || "major";
            findings.push({
              id: `INT_${medA.ingredient}_${medB.ingredient}`,
              ruleId: this.ruleId,
              findingType: "interaction",
              severity,
              systemAction: mapSeverityToSystemAction(severity),
              title: rule.title,
              description: rule.description,
              evidence: rule.evidence,
              recommendation: rule.recommendation,
              offendingItems: [medA.original, medB.original],
            });
          }
        }
      }
    }

    return findings;
  }
}

// ─── Rule 3: Duplicate Therapy Rule ───────────────────────────────────────
export class DuplicateTherapyRule implements SafetyRule {
  ruleId = "DUPLICATE-THERAPY-001";
  name = "Duplicate Therapeutic Class Rule";
  version = "1.0.0";
  category = "DUPLICATE_THERAPY" as const;
  enabled = true;

  async evaluate(context: CDSContext): Promise<SafetyFinding[]> {
    const findings: SafetyFinding[] = [];
    const seenIngredients = new Map<string, string>();

    const allMeds = [
      ...context.activeMedications.map((m) => m.medicineName),
      ...context.proposedPrescriptions.map((m) => m.medicineName),
    ];

    for (const medName of allMeds) {
      const ingredient = ClinicalTerminologyService.normalizeIngredient(medName);
      if (!ingredient) continue;

      if (seenIngredients.has(ingredient)) {
        const existingMed = seenIngredients.get(ingredient)!;
        if (existingMed.toLowerCase() !== medName.toLowerCase()) {
          findings.push({
            id: `DUP_${ingredient}`,
            ruleId: this.ruleId,
            findingType: "duplicate_therapy",
            severity: "moderate",
            systemAction: mapSeverityToSystemAction("moderate"),
            title: `Duplicate Therapy Alert: ${ingredient.toUpperCase()}`,
            description: `Multiple brand products containing identical active ingredient '${ingredient}' prescribed concurrently ('${existingMed}' and '${medName}').`,
            evidence: `Pharmacotherapeutic Duplicate Ingredient Detection.`,
            recommendation: `Consolidate prescription regimen to a single brand or dosage form.`,
            offendingItems: [existingMed, medName],
          });
        }
      } else {
        seenIngredients.set(ingredient, medName);
      }
    }

    return findings;
  }
}

// ─── Main CDS Engine Orchestrator ─────────────────────────────────────────
export class CDSEngine {
  private rules: SafetyRule[] = [];
  public engineVersion = "1.0.0";
  public terminologyVersion = "1.0.0";
  private drugInteractionRule: DrugInteractionRule;

  constructor() {
    this.drugInteractionRule = new DrugInteractionRule();
    this.registerRule(new AllergyRule());
    this.registerRule(this.drugInteractionRule);
    this.registerRule(new DuplicateTherapyRule());
  }

  registerRule(rule: SafetyRule): void {
    this.rules.push(rule);
  }

  async evaluate(context: CDSContext): Promise<SafetyEvaluationResult> {
    const startTime = Date.now();
    const activeRules = this.rules.filter((r) => r.enabled);

    const rulePromises = activeRules.map((rule) => rule.evaluate(context));
    const findingArrays = await Promise.all(rulePromises);
    const findings = findingArrays.flat();

    const hasHardStop = findings.some((f) => f.systemAction === "hard_stop");
    const hasOverrideRequired = findings.some((f) => f.systemAction === "override_required");

    const durationMs = Date.now() - startTime;

    return {
      evaluatedAt: new Date(),
      engineVersion: this.engineVersion,
      terminologyVersion: this.terminologyVersion,
      datasetVersion: this.drugInteractionRule.datasetVersion,
      findings,
      hasHardStop,
      hasOverrideRequired,
      metrics: {
        durationMs,
        rulesExecuted: activeRules.length,
        findingsCount: findings.length,
      },
    };
  }
}

export const cdsEngine = new CDSEngine();

export interface ClinicalKnowledgeEntry {
  id: string;
  category: "PROTOCOL" | "DRUG_INTERACTION" | "ICD10" | "POLICY";
  title: string;
  keywords: string[];
  content: string;
  citation: string;
}

export class ClinicalKnowledgeBase {
  private static instance: ClinicalKnowledgeBase;
  private entries: ClinicalKnowledgeEntry[] = [];

  private constructor() {
    this.seedKnowledgeEntries();
  }

  static getInstance(): ClinicalKnowledgeBase {
    if (!ClinicalKnowledgeBase.instance) {
      ClinicalKnowledgeBase.instance = new ClinicalKnowledgeBase();
    }
    return ClinicalKnowledgeBase.instance;
  }

  private seedKnowledgeEntries() {
    this.entries = [
      {
        id: "kb_hypertension_01",
        category: "PROTOCOL",
        title: "Essential Hypertension Management Protocol",
        keywords: ["hypertension", "high blood pressure", "bp", "essential hypertension"],
        content: "First-line pharmacological management includes ACE inhibitors (e.g., Lisinopril), ARBs, or Calcium Channel Blockers. Lifestyle modifications: sodium restriction (<2g/day) and DASH diet.",
        citation: "JNC 8 Hypertension Guidelines & ACC/AHA Clinical Practice Guidelines"
      },
      {
        id: "kb_asthma_01",
        category: "PROTOCOL",
        title: "Severe Bronchial Asthma Exacerbation Protocol",
        keywords: ["asthma", "bronchial asthma", "bronchospasm", "wheezing", "shortness of breath"],
        content: "Acute exacerbation management: Inhaled short-acting beta2-agonists (Albuterol) with Ipratropium bromide nebulization every 20 minutes. Systemic corticosteroids (Prednisone 40-50mg daily). Supplemental O2 to maintain SpO2 > 93%.",
        citation: "Global Initiative for Asthma (GINA) Guidelines 2026"
      },
      {
        id: "kb_diabetes_01",
        category: "PROTOCOL",
        title: "Type 2 Diabetes Mellitus Management & Glycemic Targets",
        keywords: ["diabetes", "type 2 diabetes", "t2dm", "hba1c", "blood glucose"],
        content: "Target HbA1c < 7.0% for most non-pregnant adults. Metformin is initial monotherapy unless contraindicated. Consider SGLT2 inhibitors or GLP-1 RAs for patients with established ASCVD or chronic kidney disease.",
        citation: "American Diabetes Association (ADA) Standards of Care"
      },
      {
        id: "kb_drug_int_01",
        category: "DRUG_INTERACTION",
        title: "ACE Inhibitor & Potassium-Sparing Diuretic Interaction",
        keywords: ["lisinopril", "spironolactone", "hyperkalemia", "potassium"],
        content: "Concurrent administration of Lisinopril and Spironolactone significantly increases risk of severe hyperkalemia (>5.5 mEq/L). Monitor serum potassium and renal function closely.",
        citation: "FDA Drug Interaction Advisory & Lexicomp Clinical Safety"
      }
    ];
  }

  getEntries(): ClinicalKnowledgeEntry[] {
    return [...this.entries];
  }

  addEntry(entry: ClinicalKnowledgeEntry) {
    this.entries.push(entry);
  }
}

export const clinicalKnowledgeBase = ClinicalKnowledgeBase.getInstance();

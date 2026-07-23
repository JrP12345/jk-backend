export class ClinicalTerminologyService {
  /**
   * Normalizes brand/trade drug names to standardized active generic ingredient strings.
   * e.g. "Augmentin 625" -> "amoxicillin"
   *      "Crocin 650" -> "paracetamol"
   *      "Ecosprin 75" -> "aspirin"
   */
  static normalizeIngredient(medicineName: string): string {
    if (!medicineName) return "";
    const clean = medicineName.trim().toLowerCase();

    if (clean.includes("augmentin") || clean.includes("amoxiclav") || clean.includes("amoxicillin") || clean.includes("penicillin") || clean.includes("ampicillin")) return "penicillin";
    if (clean.includes("crocin") || clean.includes("calpol") || clean.includes("dolo") || clean.includes("paracetamol") || clean.includes("acetaminophen")) return "paracetamol";
    if (clean.includes("ecosprin") || clean.includes("disprin") || clean.includes("aspirin")) return "aspirin";
    if (clean.includes("coumadin") || clean.includes("warfarin")) return "warfarin";
    if (clean.includes("zestril") || clean.includes("prinivil") || clean.includes("lisinopril")) return "lisinopril";
    if (clean.includes("aldactone") || clean.includes("spironolactone")) return "spironolactone";
    if (clean.includes("cipro") || clean.includes("ciprofloxacin")) return "ciprofloxacin";

    // Fallback: strip dosage numbers and return clean base
    return clean.replace(/\d+(\.\d+)?\s*(mg|g|ml|mcg)?/gi, "").trim();
  }

  /**
   * Checks whether a drug ingredient matches any patient known allergy string.
   */
  static isAllergicMatch(allergyItem: string, drugName: string): boolean {
    const normAllergy = ClinicalTerminologyService.normalizeIngredient(allergyItem);
    const normDrug = ClinicalTerminologyService.normalizeIngredient(drugName);
    if (!normAllergy || !normDrug) return false;

    return normDrug.includes(normAllergy) || normAllergy.includes(normDrug);
  }
}

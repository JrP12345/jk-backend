export class ClinicalTerminologyService {
  /**
   * Normalizes brand/trade drug names to standardized active generic ingredient strings.
   * e.g. "Augmentin 625" -> "penicillin amoxicillin"
   *      "Crocin 650" -> "paracetamol"
   *      "Ecosprin 75" -> "aspirin"
   */
  static normalizeIngredient(medicineName: string): string {
    if (!medicineName) return "";
    const clean = medicineName.trim().toLowerCase();

    // Penicillins / Beta-lactams
    if (
      clean.includes("augmentin") ||
      clean.includes("amoxiclav") ||
      clean.includes("amoxicillin") ||
      clean.includes("penicillin") ||
      clean.includes("ampicillin")
    ) {
      return "penicillin amoxicillin";
    }

    // Analgesics / Antipyretics
    if (
      clean.includes("crocin") ||
      clean.includes("calpol") ||
      clean.includes("dolo") ||
      clean.includes("paracetamol") ||
      clean.includes("acetaminophen")
    ) {
      return "paracetamol";
    }

    // Antiplatelets / Salicylates
    if (clean.includes("ecosprin") || clean.includes("disprin") || clean.includes("aspirin")) {
      return "aspirin";
    }

    // Anticoagulants
    if (clean.includes("coumadin") || clean.includes("warfarin")) {
      return "warfarin";
    }
    if (clean.includes("eliquis") || clean.includes("apixaban") || clean.includes("xarelto") || clean.includes("rivaroxaban")) {
      return "anticoagulant";
    }

    // NSAIDs
    if (
      clean.includes("combiflam") ||
      clean.includes("voveran") ||
      clean.includes("diclofenac") ||
      clean.includes("zerodol") ||
      clean.includes("aceclofenac") ||
      clean.includes("brufen") ||
      clean.includes("ibuprofen") ||
      clean.includes("naproxen")
    ) {
      return "nsaid";
    }

    // PDE-5 Inhibitors & Nitrates
    if (
      clean.includes("viagra") ||
      clean.includes("manforce") ||
      clean.includes("sildenafil") ||
      clean.includes("tadalafil")
    ) {
      return "sildenafil";
    }
    if (
      clean.includes("sorbitrate") ||
      clean.includes("nitroglycerin") ||
      clean.includes("nitrocontin") ||
      clean.includes("isosorbide") ||
      clean.includes("mononitrate") ||
      clean.includes("nitrate")
    ) {
      return "nitrate";
    }

    // Antifolates & Antimetabolites
    if (clean.includes("folitrax") || clean.includes("methotrexate")) {
      return "methotrexate";
    }
    if (
      clean.includes("bactrim") ||
      clean.includes("septran") ||
      clean.includes("trimethoprim") ||
      clean.includes("cotrimoxazole")
    ) {
      return "trimethoprim";
    }

    // Serotonergics & MAOIs
    if (
      clean.includes("tramadol") ||
      clean.includes("ultram") ||
      clean.includes("tramazac") ||
      clean.includes("prozac") ||
      clean.includes("fluoxetine") ||
      clean.includes("sertraline") ||
      clean.includes("zoloft") ||
      clean.includes("escitalopram") ||
      clean.includes("nexito")
    ) {
      return "serotonergic";
    }
    if (
      clean.includes("linezolid") ||
      clean.includes("lizomac") ||
      clean.includes("linid") ||
      clean.includes("zyvox")
    ) {
      return "linezolid";
    }

    // Statins & CYP3A4 Inhibitors
    if (
      clean.includes("atorva") ||
      clean.includes("atorvastatin") ||
      clean.includes("lipitor") ||
      clean.includes("rosuvas") ||
      clean.includes("rosuvastatin") ||
      clean.includes("simvastatin")
    ) {
      return "statin";
    }
    if (
      clean.includes("claribid") ||
      clean.includes("clarithromycin") ||
      clean.includes("ketoconazole") ||
      clean.includes("itraconazole") ||
      clean.includes("canditral")
    ) {
      return "cyp3a4_inhibitor";
    }

    // QT Prolonging Agents
    if (
      clean.includes("diflucan") ||
      clean.includes("fluconazole") ||
      clean.includes("forcan") ||
      clean.includes("azithral") ||
      clean.includes("azithromycin") ||
      clean.includes("zithromax")
    ) {
      return "qt_prolonging_antimicrobial";
    }
    if (
      clean.includes("ondansetron") ||
      clean.includes("emset") ||
      clean.includes("zofran") ||
      clean.includes("domperidone") ||
      clean.includes("vomistop")
    ) {
      return "qt_prolonging_antiemetic";
    }

    // Antihypertensives & Diuretics
    if (clean.includes("zestril") || clean.includes("prinivil") || clean.includes("lisinopril")) {
      return "lisinopril";
    }
    if (clean.includes("aldactone") || clean.includes("spironolactone")) {
      return "spironolactone";
    }
    if (clean.includes("cipro") || clean.includes("ciprofloxacin")) {
      return "ciprofloxacin";
    }
    if (
      clean.includes("gelusil") ||
      clean.includes("digene") ||
      clean.includes("mucaine") ||
      clean.includes("antacid")
    ) {
      return "antacid";
    }

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

    // Check individual token matches for multi-token returns like "penicillin amoxicillin"
    const allergyTokens = normAllergy.split(/\s+/);
    const drugTokens = normDrug.split(/\s+/);

    return drugTokens.some((d) => allergyTokens.some((a) => d.includes(a) || a.includes(d)));
  }
}

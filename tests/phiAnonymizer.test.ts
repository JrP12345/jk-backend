import { describe, it, expect } from "vitest";
import { PHIAnonymizer } from "../utilities/phiAnonymizer.ts";

describe("HIPAA PHI Anonymizer Utility Tests", () => {
  it("should replace patient names and MRNs with anonymized tokens", () => {
    const originalText = "Patient John Doe (MRN: MRN-6A64E9) presents with essential hypertension. Maria Garcia has asthma.";
    const patientList = [
      { name: "John Doe", mrn: "MRN-6A64E9" },
      { name: "Maria Garcia", mrn: "MRN-D680AF" }
    ];

    const { anonymizedText, tokenMap } = PHIAnonymizer.anonymizeText(originalText, patientList);

    expect(anonymizedText).not.toContain("John Doe");
    expect(anonymizedText).not.toContain("MRN-6A64E9");
    expect(anonymizedText).not.toContain("Maria Garcia");
    expect(anonymizedText).toContain("[PATIENT_A]");
    expect(anonymizedText).toContain("[MRN_TOKEN_1]");
    expect(anonymizedText).toContain("[PATIENT_B]");

    // Rehydration
    const rehydrated = PHIAnonymizer.rehydrateText(anonymizedText, tokenMap);
    expect(rehydrated).toBe(originalText);
  });
});

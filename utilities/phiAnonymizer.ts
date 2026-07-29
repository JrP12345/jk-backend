export interface PatientMapEntry {
  token: string;
  realName: string;
  realMrn?: string;
  realEmail?: string;
}

export interface PHICandidate {
  value: string;
  token: string;
  type: "PATIENT" | "MRN" | "EMAIL" | "PHONE";
}

export class PHIAnonymizer {
  /**
   * Escapes special regular expression characters in a string.
   */
  public static escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Anonymizes sensitive PHI identifiers in clinical text before passing to external AI LLMs.
   * Utilizes regex word boundaries and length-descending sorting to prevent partial substring collisions.
   */
  static anonymizeText(
    text: string,
    patientList: Array<{ name?: string; mrn?: string; email?: string; phone?: string }>
  ): {
    anonymizedText: string;
    tokenMap: Map<string, string>;
  } {
    if (!text) {
      return { anonymizedText: "", tokenMap: new Map() };
    }

    let anonymizedText = text;
    const tokenMap = new Map<string, string>(); // token -> realValue

    const candidates: PHICandidate[] = [];

    patientList.forEach((patient, idx) => {
      const patientLetter = String.fromCharCode(65 + (idx % 26));
      
      if (patient.name && patient.name.trim().length > 1) {
        candidates.push({
          value: patient.name.trim(),
          token: `[PATIENT_${patientLetter}]`,
          type: "PATIENT"
        });
      }

      if (patient.mrn && patient.mrn.trim().length > 1) {
        candidates.push({
          value: patient.mrn.trim(),
          token: `[MRN_TOKEN_${idx + 1}]`,
          type: "MRN"
        });
      }

      if (patient.email && patient.email.trim().length > 1) {
        candidates.push({
          value: patient.email.trim(),
          token: `[EMAIL_TOKEN_${idx + 1}]`,
          type: "EMAIL"
        });
      }

      if (patient.phone && patient.phone.trim().length > 3) {
        candidates.push({
          value: patient.phone.trim(),
          token: `[PHONE_TOKEN_${idx + 1}]`,
          type: "PHONE"
        });
      }
    });

    // Sort candidates by length descending to prevent shorter sub-names from overwriting full names
    candidates.sort((a, b) => b.value.length - a.value.length);

    candidates.forEach((cand) => {
      if (anonymizedText.includes(cand.value)) {
        // Build regex with word boundary if candidate value starts/ends with alphanumeric char
        const escaped = PHIAnonymizer.escapeRegExp(cand.value);
        const startsWithWord = /^\w/.test(cand.value);
        const endsWithWord = /\w$/.test(cand.value);
        const pattern = `${startsWithWord ? "\\b" : ""}${escaped}${endsWithWord ? "\\b" : ""}`;
        const regex = new RegExp(pattern, "g");

        if (regex.test(anonymizedText)) {
          anonymizedText = anonymizedText.replace(regex, cand.token);
          tokenMap.set(cand.token, cand.value);
        }
      }
    });

    return { anonymizedText, tokenMap };
  }

  /**
   * Re-hydrates tokenized placeholders back into real patient identifiers before returning to authenticated client.
   */
  static rehydrateText(anonymizedResponse: string, tokenMap: Map<string, string>): string {
    let rehydrated = anonymizedResponse || "";
    tokenMap.forEach((realValue, token) => {
      rehydrated = rehydrated.replaceAll(token, realValue);
    });
    return rehydrated;
  }
}


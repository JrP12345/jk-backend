export interface PatientMapEntry {
  token: string;
  realName: string;
  realMrn?: string;
  realEmail?: string;
}

export class PHIAnonymizer {
  /**
   * Anonymizes sensitive PHI identifiers in clinical text before passing to external AI LLMs.
   */
  static anonymizeText(text: string, patientList: Array<{ name?: string; mrn?: string; email?: string }>): {
    anonymizedText: string;
    tokenMap: Map<string, string>;
  } {
    let anonymizedText = text;
    const tokenMap = new Map<string, string>(); // token -> realValue

    patientList.forEach((patient, idx) => {
      const tokenName = `[PATIENT_${String.fromCharCode(65 + (idx % 26))}]`;
      
      if (patient.name && patient.name.trim() && patient.name.trim().length > 1) {
        const val = patient.name.trim();
        if (anonymizedText.includes(val)) {
          anonymizedText = anonymizedText.replaceAll(val, tokenName);
          tokenMap.set(tokenName, val);
        }
      }

      if (patient.mrn && patient.mrn.trim()) {
        const val = patient.mrn.trim();
        const tokenMrn = `[MRN_TOKEN_${idx + 1}]`;
        if (anonymizedText.includes(val)) {
          anonymizedText = anonymizedText.replaceAll(val, tokenMrn);
          tokenMap.set(tokenMrn, val);
        }
      }

      if (patient.email && patient.email.trim()) {
        const val = patient.email.trim();
        const tokenEmail = `[EMAIL_TOKEN_${idx + 1}]`;
        if (anonymizedText.includes(val)) {
          anonymizedText = anonymizedText.replaceAll(val, tokenEmail);
          tokenMap.set(tokenEmail, val);
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

  private static escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

export interface PatientMapEntry {
  token: string;
  realName: string;
  realMrn?: string;
  realEmail?: string;
}

export interface PHICandidate {
  value: string;
  token: string;
  type: "PATIENT" | "MRN" | "EMAIL" | "PHONE" | "SSN" | "DOB";
}

export class AIDataPrivacyError extends Error {
  public statusCode = 422;
  constructor(message: string = "AI Data Privacy Policy Violation: Sensitive identifiable data detected or unmasked") {
    super(message);
    this.name = "AIDataPrivacyError";
  }
}

// Regex patterns for structured free-text detection
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_REGEX = /(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;
const MRN_REGEX = /\b(?:MRN|mrn|Chart#?)[\s:#-]*([A-Za-z0-9-]{4,15})\b/gi;
const DOB_REGEX = /\b(?:DOB|dob|Date of Birth|Birthdate)[\s:#-]*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\b/gi;

export class PHIAnonymizer {
  /**
   * Escapes special regular expression characters in a string.
   */
  public static escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Scans text for unmasked high-risk identifiers without tokenizing.
   * Used for fail-closed validation before external transmission.
   */
  public static detectUnmaskedPHI(text: string): { hasUnmaskedPHI: boolean; detectedCategories: string[] } {
    if (!text) return { hasUnmaskedPHI: false, detectedCategories: [] };

    const detected: string[] = [];
    if (EMAIL_REGEX.test(text)) detected.push("EMAIL_ADDRESS");
    EMAIL_REGEX.lastIndex = 0;

    if (PHONE_REGEX.test(text)) detected.push("PHONE_NUMBER");
    PHONE_REGEX.lastIndex = 0;

    if (SSN_REGEX.test(text)) detected.push("GOVERNMENT_ID_SSN");
    SSN_REGEX.lastIndex = 0;

    if (MRN_REGEX.test(text)) detected.push("MEDICAL_RECORD_NUMBER");
    MRN_REGEX.lastIndex = 0;

    if (DOB_REGEX.test(text)) detected.push("DATE_OF_BIRTH");
    DOB_REGEX.lastIndex = 0;

    return {
      hasUnmaskedPHI: detected.length > 0,
      detectedCategories: detected
    };
  }

  /**
   * Anonymizes sensitive PHI identifiers in clinical text before passing to external AI LLMs.
   * Utilizes regex word boundaries and length-descending sorting to prevent partial substring collisions.
   * Also scrubs free-text emails, phone numbers, and SSNs.
   */
  static anonymizeText(
    text: string,
    patientList: Array<{ name?: string; mrn?: string; email?: string; phone?: string }> = []
  ): {
    anonymizedText: string;
    tokenMap: Map<string, string>;
    disclosedCategories: string[];
  } {
    if (!text) {
      return { anonymizedText: "", tokenMap: new Map(), disclosedCategories: [] };
    }

    let anonymizedText = text;
    const tokenMap = new Map<string, string>(); // token -> realValue
    const disclosedCategories = new Set<string>();

    const candidates: PHICandidate[] = [];

    // 1. Process candidate patient profiles
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
        const escaped = PHIAnonymizer.escapeRegExp(cand.value);
        const startsWithWord = /^\w/.test(cand.value);
        const endsWithWord = /\w$/.test(cand.value);
        const pattern = `${startsWithWord ? "\\b" : ""}${escaped}${endsWithWord ? "\\b" : ""}`;
        const regex = new RegExp(pattern, "g");

        if (regex.test(anonymizedText)) {
          anonymizedText = anonymizedText.replace(regex, cand.token);
          tokenMap.set(cand.token, cand.value);
          disclosedCategories.add(cand.type === "PATIENT" ? "PATIENT_NAME" : cand.type);
        }
      }
    });

    // 2. Scan and mask free-text structured patterns
    // Free text emails
    let emailCounter = 1;
    anonymizedText = anonymizedText.replace(EMAIL_REGEX, (match) => {
      // Don't re-tokenize an existing token
      if (match.startsWith("[EMAIL_TOKEN_")) return match;
      const token = `[EMAIL_TOKEN_ANON_${emailCounter++}]`;
      tokenMap.set(token, match);
      disclosedCategories.add("EMAIL");
      return token;
    });

    // Free text phones
    let phoneCounter = 1;
    anonymizedText = anonymizedText.replace(PHONE_REGEX, (match) => {
      if (match.startsWith("[PHONE_TOKEN_")) return match;
      const token = `[PHONE_TOKEN_ANON_${phoneCounter++}]`;
      tokenMap.set(token, match);
      disclosedCategories.add("PHONE");
      return token;
    });

    // Free text SSNs
    let ssnCounter = 1;
    anonymizedText = anonymizedText.replace(SSN_REGEX, (match) => {
      const token = `[SSN_TOKEN_ANON_${ssnCounter++}]`;
      tokenMap.set(token, match);
      disclosedCategories.add("SSN");
      return token;
    });

    return {
      anonymizedText,
      tokenMap,
      disclosedCategories: Array.from(disclosedCategories)
    };
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

import { BaseAgent } from "./BaseAgent.ts";

export class ClinicalAgent extends BaseAgent {
  name = "ClinicalAgent";
  role = "Attending Physician & CDS Specialist";
  systemDirective = "You are ANANTA Clinical AI Agent specializing in evidence-based SOAP notes, CDS drug interaction safety checks, differential diagnoses, and lab report interpretations.";

  canHandle(prompt: string, route?: string): boolean {
    const p = prompt.toLowerCase();
    const r = (route || "").toLowerCase();
    return r.includes("patient") || r.includes("clinical") || p.includes("soap") || p.includes("vitals") || p.includes("diagnosis") || p.includes("lab");
  }
}

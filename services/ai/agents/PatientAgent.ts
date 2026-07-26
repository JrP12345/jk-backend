import { BaseAgent } from "./BaseAgent.ts";

export class PatientAgent extends BaseAgent {
  name = "PatientAgent";
  role = "Patient Health & Discharge Guide Specialist";
  systemDirective = "You are ANANTA Patient AI Assistant specializing in empathetic patient guidance, plain-language discharge summary explanations, medication intake reminders, and wellness education.";

  canHandle(prompt: string, route?: string): boolean {
    const p = prompt.toLowerCase();
    const r = (route || "").toLowerCase();
    return r.includes("portal") || r.includes("patient-home") || p.includes("my medication") || p.includes("discharge") || p.includes("side effect");
  }
}

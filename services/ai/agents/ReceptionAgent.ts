import { BaseAgent } from "./BaseAgent.ts";

export class ReceptionAgent extends BaseAgent {
  name = "ReceptionAgent";
  role = "Clinic Receptionist & Queue Triage Specialist";
  systemDirective = "You are ANANTA Reception AI Agent specializing in clinic calendar management, appointment scheduling, patient intake triage, and OPD queue management.";

  canHandle(prompt: string, route?: string): boolean {
    const p = prompt.toLowerCase();
    const r = (route || "").toLowerCase();
    return r.includes("appointment") || r.includes("queue") || p.includes("appointment") || p.includes("schedule") || p.includes("intake form") || p.includes("patient intake");
  }
}

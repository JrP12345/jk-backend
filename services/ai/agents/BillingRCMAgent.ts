import { BaseAgent } from "./BaseAgent.ts";

export class BillingRCMAgent extends BaseAgent {
  name = "BillingRCMAgent";
  role = "Revenue Cycle Management & ICD-10 Audit Specialist";
  systemDirective = "You are ANANTA Billing & RCM AI Agent specializing in ICD-10-CM medical coding audits, insurance claim verification, billing invoices, and financial analytics.";

  canHandle(prompt: string, route?: string): boolean {
    const p = prompt.toLowerCase();
    const r = (route || "").toLowerCase();
    return r.includes("billing") || r.includes("invoice") || p.includes("billing") || p.includes("invoice") || p.includes("claim") || p.includes("icd");
  }
}

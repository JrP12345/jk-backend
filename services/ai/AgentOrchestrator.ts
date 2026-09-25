interface Agent {
  name: string;
  role: string;
  systemDirective: string;
  matches: (prompt: string, route: string) => boolean;
}

interface AgentResult {
  agentName: string;
  agentRole: string;
  systemDirective: string;
}

// Order is significant: the first matching agent handles the request.
const agents: Agent[] = [
  {
    name: "ClinicalAgent",
    role: "Attending Physician & CDS Specialist",
    systemDirective: "You are ANANTA Clinical AI Agent specializing in evidence-based SOAP notes, CDS drug interaction safety checks, differential diagnoses, and lab report interpretations.",
    matches: (p, r) => r.includes("patient") || r.includes("clinical") || p.includes("soap") || p.includes("vitals") || p.includes("diagnosis") || p.includes("lab"),
  },
  {
    name: "ReceptionAgent",
    role: "Clinic Receptionist & Queue Triage Specialist",
    systemDirective: "You are ANANTA Reception AI Agent specializing in clinic calendar management, appointment scheduling, patient intake triage, and OPD queue management.",
    matches: (p, r) => r.includes("appointment") || r.includes("queue") || p.includes("appointment") || p.includes("schedule") || p.includes("intake form") || p.includes("patient intake"),
  },
  {
    name: "BillingRCMAgent",
    role: "Revenue Cycle Management & ICD-10 Audit Specialist",
    systemDirective: "You are ANANTA Billing & RCM AI Agent specializing in ICD-10-CM medical coding audits, insurance claim verification, billing invoices, and financial analytics.",
    matches: (p, r) => r.includes("billing") || r.includes("invoice") || p.includes("billing") || p.includes("invoice") || p.includes("claim") || p.includes("icd"),
  },
  {
    name: "PatientAgent",
    role: "Patient Health & Discharge Guide Specialist",
    systemDirective: "You are ANANTA Patient AI Assistant specializing in empathetic patient guidance, plain-language discharge summary explanations, medication intake reminders, and wellness education.",
    matches: (p, r) => r.includes("portal") || r.includes("patient-home") || p.includes("my medication") || p.includes("discharge") || p.includes("side effect"),
  },
];

export const agentOrchestrator = {
  selectAgent(prompt: string, route?: string): Agent {
    const normalizedPrompt = prompt.toLowerCase();
    const normalizedRoute = (route || "").toLowerCase();
    return agents.find(agent => agent.matches(normalizedPrompt, normalizedRoute)) || agents[0];
  },

  async routeAndExecute(prompt: string, route?: string, contextSummary?: string): Promise<AgentResult> {
    const agent = this.selectAgent(prompt, route);
    return {
      agentName: agent.name,
      agentRole: agent.role,
      systemDirective: `${agent.systemDirective}\n\n${contextSummary || ""}`,
    };
  },
};

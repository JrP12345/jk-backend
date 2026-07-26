import { BaseAgent, type AgentResult } from "./agents/BaseAgent.ts";
import { ClinicalAgent } from "./agents/ClinicalAgent.ts";
import { ReceptionAgent } from "./agents/ReceptionAgent.ts";
import { BillingRCMAgent } from "./agents/BillingRCMAgent.ts";
import { PatientAgent } from "./agents/PatientAgent.ts";

export class AgentOrchestrator {
  private static instance: AgentOrchestrator;
  private agents: BaseAgent[] = [];
  private defaultAgent: BaseAgent;

  private constructor() {
    this.agents = [
      new ClinicalAgent(),
      new ReceptionAgent(),
      new BillingRCMAgent(),
      new PatientAgent()
    ];
    this.defaultAgent = this.agents[0]; // ClinicalAgent default
  }

  static getInstance(): AgentOrchestrator {
    if (!AgentOrchestrator.instance) {
      AgentOrchestrator.instance = new AgentOrchestrator();
    }
    return AgentOrchestrator.instance;
  }

  /**
   * Evaluates prompt & active route context to select and delegate execution to the best specialized agent.
   */
  selectAgent(prompt: string, route?: string): BaseAgent {
    for (const agent of this.agents) {
      if (agent.canHandle(prompt, route)) {
        return agent;
      }
    }
    return this.defaultAgent;
  }

  async routeAndExecute(prompt: string, route?: string, contextSummary?: string): Promise<AgentResult> {
    const agent = this.selectAgent(prompt, route);
    return await agent.process(prompt, contextSummary);
  }
}

export const agentOrchestrator = AgentOrchestrator.getInstance();

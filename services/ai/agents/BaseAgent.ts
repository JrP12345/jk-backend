export interface AgentResult {
  agentName: string;
  agentRole: string;
  systemDirective: string;
}

export abstract class BaseAgent {
  abstract name: string;
  abstract role: string;
  abstract systemDirective: string;

  abstract canHandle(prompt: string, route?: string): boolean;

  async process(prompt: string, contextSummary?: string): Promise<AgentResult> {
    return {
      agentName: this.name,
      agentRole: this.role,
      systemDirective: `${this.systemDirective}\n\n${contextSummary || ""}`
    };
  }
}

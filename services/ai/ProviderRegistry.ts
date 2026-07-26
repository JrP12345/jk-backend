import type { AIProvider } from "./AIProvider.ts";

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<string, AIProvider> = new Map();
  private primaryProviderName = "GoogleGeminiAI";

  private constructor() {
    this.registerProvider({
      name: "FallbackSimulationAI",
      isHealthy: async () => true,
      generateSOAPNote: async (input) => ({
        subjective: `Chief complaint: ${input.chiefComplaint}`,
        objective: "Vitals WNL",
        assessment: "Clinical evaluation complete",
        plan: "Supportive therapy"
      }),
      queryPatientHealthAssistant: async (input) => ({
        answer: "Simulation response",
        citations: ["System Record"],
        disclaimer: "Grounded AI guidance"
      })
    });
  }

  static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  registerProvider(provider: AIProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name?: string): AIProvider | undefined {
    if (name && this.providers.has(name)) {
      return this.providers.get(name);
    }
    return this.providers.get(this.primaryProviderName) || Array.from(this.providers.values())[0];
  }

  setPrimaryProvider(name: string): void {
    if (this.providers.has(name)) {
      this.primaryProviderName = name;
    }
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  async checkHealth(): Promise<Record<string, boolean>> {
    const healthMap: Record<string, boolean> = {};
    for (const [name, provider] of this.providers.entries()) {
      try {
        healthMap[name] = await provider.isHealthy();
      } catch {
        healthMap[name] = false;
      }
    }
    return healthMap;
  }
}

export const providerRegistry = ProviderRegistry.getInstance();

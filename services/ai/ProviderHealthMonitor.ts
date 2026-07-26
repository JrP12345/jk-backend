import { providerRegistry } from "./ProviderRegistry.ts";

export interface ProviderHealthStatus {
  name: string;
  isHealthy: boolean;
  lastCheckedAt: Date;
  latencyMs: number;
}

export class ProviderHealthMonitor {
  private static instance: ProviderHealthMonitor;
  private healthCache: Map<string, ProviderHealthStatus> = new Map();

  private constructor() {}

  static getInstance(): ProviderHealthMonitor {
    if (!ProviderHealthMonitor.instance) {
      ProviderHealthMonitor.instance = new ProviderHealthMonitor();
    }
    return ProviderHealthMonitor.instance;
  }

  async runHealthCheck(): Promise<Record<string, ProviderHealthStatus>> {
    const providers = providerRegistry.listProviders();
    for (const name of providers) {
      const provider = providerRegistry.getProvider(name);
      if (!provider) continue;

      const startTime = Date.now();
      let isHealthy = false;
      try {
        isHealthy = await provider.isHealthy();
      } catch {
        isHealthy = false;
      }
      const latencyMs = Date.now() - startTime;

      const status: ProviderHealthStatus = {
        name,
        isHealthy,
        lastCheckedAt: new Date(),
        latencyMs
      };
      this.healthCache.set(name, status);
    }

    const result: Record<string, ProviderHealthStatus> = {};
    this.healthCache.forEach((val, key) => {
      result[key] = val;
    });
    return result;
  }

  getSystemStatus(): { overallStatus: "HEALTHY" | "DEGRADED" | "UNHEALTHY"; providers: Record<string, ProviderHealthStatus> } {
    const providers: Record<string, ProviderHealthStatus> = {};
    let healthyCount = 0;
    let totalCount = 0;

    this.healthCache.forEach((val, key) => {
      providers[key] = val;
      totalCount++;
      if (val.isHealthy) healthyCount++;
    });

    let overallStatus: "HEALTHY" | "DEGRADED" | "UNHEALTHY" = "HEALTHY";
    if (healthyCount === 0 && totalCount > 0) {
      overallStatus = "UNHEALTHY";
    } else if (healthyCount < totalCount) {
      overallStatus = "DEGRADED";
    }

    return { overallStatus, providers };
  }
}

export const providerHealthMonitor = ProviderHealthMonitor.getInstance();

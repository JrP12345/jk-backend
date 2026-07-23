import type { ClinicalScoringAlgorithm, ScoringResult } from "../types/scoring.ts";
import { NEWS2Algorithm } from "./NEWS2Algorithm.ts";

export class ScoringEngine {
  private algorithms = new Map<string, ClinicalScoringAlgorithm>();

  constructor() {
    this.registerAlgorithm(new NEWS2Algorithm());
  }

  registerAlgorithm(algorithm: ClinicalScoringAlgorithm): void {
    this.algorithms.set(algorithm.id.toUpperCase(), algorithm);
  }

  evaluate(algorithmId: string, observations: Array<{ id?: string; code: string; value: any; unit?: string }>): ScoringResult {
    const algo = this.algorithms.get(algorithmId.toUpperCase());
    if (!algo) {
      throw new Error(`Clinical scoring algorithm '${algorithmId}' not registered`);
    }

    return algo.evaluate(observations);
  }
}

export const scoringEngine = new ScoringEngine();

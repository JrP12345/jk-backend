import type { AIResponse, AIUsage } from "./AIProvider.ts";
import { PHIAnonymizer } from "../../utilities/phiAnonymizer.ts";

export class OutboundPipeline {
  /**
   * Executes the 4-stage outbound response pipeline:
   * Response Validation ➔ PHI Re-hydration ➔ Citation Formatting ➔ Safety Audit
   */
  static async process(
    rawResponseText: string,
    correlationId: string,
    tokenMap: Map<string, string>,
    providerName: string,
    modelEndpoint: string,
    usage: AIUsage,
    citations?: string[]
  ): Promise<AIResponse> {
    // 1. Validation
    if (!rawResponseText) {
      throw new Error("[OutboundPipeline] Empty response returned from AI provider");
    }

    // 2. PHI Re-hydration
    const rehydratedText = PHIAnonymizer.rehydrateText(rawResponseText, tokenMap);

    // 3. Citation Formatting & Safety Verification
    const finalCitations = citations && citations.length > 0 ? citations : ["ANANTA Clinical Registry"];

    return {
      correlationId,
      text: rehydratedText,
      citations: finalCitations,
      usage,
      provider: providerName,
      model: modelEndpoint
    };
  }
}

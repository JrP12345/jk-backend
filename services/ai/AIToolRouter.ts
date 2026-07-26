import { aiToolRegistry, type AIToolDefinition } from "./AIToolRegistry.ts";

export interface DetectedToolIntent {
  detected: boolean;
  tool?: AIToolDefinition;
  parsedArguments?: Record<string, any>;
  confidence: number;
}

export class AIToolRouter {
  private static instance: AIToolRouter;

  private constructor() {}

  static getInstance(): AIToolRouter {
    if (!AIToolRouter.instance) {
      AIToolRouter.instance = new AIToolRouter();
    }
    return AIToolRouter.instance;
  }

  /**
   * Evaluates natural language user prompt to detect tool intent.
   */
  detectIntent(prompt: string): DetectedToolIntent {
    if (!prompt) return { detected: false, confidence: 0 };
    const p = prompt.toLowerCase();

    if (p.includes("appointment") && (p.includes("schedule") || p.includes("book") || p.includes("follow-up"))) {
      return {
        detected: true,
        tool: aiToolRegistry.getTool("createAppointmentTool"),
        parsedArguments: { action: "SCHEDULE_APPOINTMENT" },
        confidence: 0.95
      };
    }

    if (p.includes("prescribe") || p.includes("order medication") || p.includes("write prescription")) {
      return {
        detected: true,
        tool: aiToolRegistry.getTool("prescribeMedicationTool"),
        parsedArguments: { action: "PRESCRIBE_MEDICATION" },
        confidence: 0.92
      };
    }

    if (p.includes("soap note") || p.includes("draft note") || p.includes("generate soap")) {
      return {
        detected: true,
        tool: aiToolRegistry.getTool("generateSOAPNoteTool"),
        parsedArguments: { action: "GENERATE_SOAP_NOTE" },
        confidence: 0.90
      };
    }

    return { detected: false, confidence: 0 };
  }
}

export const aiToolRouter = AIToolRouter.getInstance();

export interface AIToolDefinition {
  name: string;
  description: string;
  parametersSchema: Record<string, string>;
  requiresClinicianApproval: boolean;
}

export class AIToolRegistry {
  private static instance: AIToolRegistry;
  private tools: Map<string, AIToolDefinition> = new Map();

  private constructor() {
    this.registerDefaults();
  }

  static getInstance(): AIToolRegistry {
    if (!AIToolRegistry.instance) {
      AIToolRegistry.instance = new AIToolRegistry();
    }
    return AIToolRegistry.instance;
  }

  private registerDefaults() {
    this.tools.set("createAppointmentTool", {
      name: "createAppointmentTool",
      description: "Schedule a patient consultation or follow-up appointment in the clinic calendar",
      parametersSchema: { patientId: "string", appointmentDate: "ISO string", doctorId: "string", type: "string" },
      requiresClinicianApproval: true
    });

    this.tools.set("prescribeMedicationTool", {
      name: "prescribeMedicationTool",
      description: "Draft a digital prescription for a patient",
      parametersSchema: { patientId: "string", medicationName: "string", dosage: "string", instructions: "string" },
      requiresClinicianApproval: true
    });

    this.tools.set("generateSOAPNoteTool", {
      name: "generateSOAPNoteTool",
      description: "Generate structured SOAP note for consultation chart",
      parametersSchema: { patientId: "string", chiefComplaint: "string" },
      requiresClinicianApproval: false
    });
  }

  getTool(name: string): AIToolDefinition | undefined {
    return this.tools.get(name);
  }

  listTools(): AIToolDefinition[] {
    return Array.from(this.tools.values());
  }
}

export const aiToolRegistry = AIToolRegistry.getInstance();

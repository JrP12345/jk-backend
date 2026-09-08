import { aiToolRegistry, type AIToolDefinition } from "./AIToolRegistry.ts";

export interface DetectedToolIntent {
  detected: boolean;
  tool?: AIToolDefinition;
  parsedArguments?: Record<string, any>;
  confidence: number;
}

export const LLM_CLINICAL_TOOL_DECLARATIONS = [
  {
    name: "createAppointmentTool",
    description: "Schedule a patient consultation or follow-up appointment in the clinic calendar",
    parameters: {
      type: "OBJECT",
      properties: {
        patientId: { type: "STRING", description: "Target patient unique identifier" },
        doctorId: { type: "STRING", description: "Attending doctor unique identifier" },
        clinicId: { type: "STRING", description: "Clinic facility identifier" },
        appointmentDate: { type: "STRING", description: "ISO datetime for scheduled encounter" },
        type: { type: "STRING", description: "Encounter modality: in_person, teleconsult, follow_up" },
        notes: { type: "STRING", description: "Reason for encounter or triage notes" }
      },
      required: ["patientId", "doctorId", "clinicId"]
    }
  },
  {
    name: "prescribeMedicationTool",
    description: "Draft a digital prescription for a patient encounter requiring doctor approval",
    parameters: {
      type: "OBJECT",
      properties: {
        patientId: { type: "STRING", description: "Target patient unique identifier" },
        clinicId: { type: "STRING", description: "Clinic facility identifier" },
        medicineName: { type: "STRING", description: "Commercial or generic pharmaceutical name" },
        dosage: { type: "STRING", description: "Dosage unit (e.g. 500mg, 10ml)" },
        frequency: { type: "STRING", description: "Regimen frequency (e.g. 1-0-1, TID)" },
        duration: { type: "STRING", description: "Therapy duration (e.g. 5 days, 2 weeks)" },
        instructions: { type: "STRING", description: "Administration instructions" }
      },
      required: ["patientId", "clinicId", "medicineName"]
    }
  },
  {
    name: "generateSOAPNoteTool",
    description: "Generate structured clinical SOAP documentation draft for patient chart",
    parameters: {
      type: "OBJECT",
      properties: {
        chiefComplaint: { type: "STRING", description: "Primary chief complaint narrative" },
        examinationFindings: { type: "STRING", description: "Objective physical examination findings" },
        history: { type: "STRING", description: "History of present illness and medical history" }
      },
      required: ["chiefComplaint"]
    }
  }
];

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
   * Evaluates natural language user prompt to detect tool intent and extract arguments.
   */
  detectIntent(prompt: string, contextPatientId?: string, contextClinicId?: string): DetectedToolIntent {
    if (!prompt || !prompt.trim()) return { detected: false, confidence: 0 };
    const p = prompt.trim();
    const lower = p.toLowerCase();

    // Guard against speculative clinical inquiries and informational questions
    // (e.g. "Should I prescribe...", "Is it safe to prescribe...", "Why prescribe...", "Contraindicated...")
    const isSpeculativeInquiry = /\b(should (we|i)|is it (safe|recommended|appropriate|advised)|why (prescribe|did|was)|does the patient need|contraindicated|reaction to|adverse effects of)\b/i.test(p);
    if (isSpeculativeInquiry) {
      return { detected: false, confidence: 0 };
    }

    // 1. SOAP Note Generation Intent
    if (lower.includes("soap note") || lower.includes("draft note") || lower.includes("generate soap") || lower.includes("clinical note")) {
      const match = p.match(/(?:for|regarding|with complaint of|chief complaint:?)\s+([^.]+)/i);
      const chiefComplaint = match ? match[1].trim() : p;
      return {
        detected: true,
        tool: aiToolRegistry.getTool("generateSOAPNoteTool"),
        parsedArguments: {
          action: "GENERATE_SOAP_NOTE",
          chiefComplaint: chiefComplaint || "General consultation",
          patientId: contextPatientId
        },
        confidence: 0.94
      };
    }

    // 2. Prescription Intent
    if (lower.includes("prescribe") || lower.includes("order medication") || lower.includes("write prescription") || lower.includes("rx:")) {
      const rxMatch = p.match(/prescribe\s+([A-Za-z0-9\s]+?)(?:\s+(\d+\s*(?:mg|ml|mcg|g|tab)))?(?:\s+(?:for|to|bid|tid|daily|every|prn)|$)/i);
      const medicineName = rxMatch ? rxMatch[1].trim() : undefined;
      const dosage = rxMatch?.[2] ? rxMatch[2].trim() : undefined;

      return {
        detected: true,
        tool: aiToolRegistry.getTool("prescribeMedicationTool"),
        parsedArguments: {
          action: "PRESCRIBE_MEDICATION",
          medicineName: medicineName || "Medication",
          dosage: dosage || "As directed",
          patientId: contextPatientId,
          clinicId: contextClinicId
        },
        confidence: medicineName ? 0.95 : 0.82
      };
    }

    // 3. Appointment Scheduling Intent
    if (lower.includes("appointment") && (lower.includes("schedule") || lower.includes("book") || lower.includes("follow-up") || lower.includes("consultation"))) {
      const dateMatch = p.match(/(?:on|at|tomorrow|next week|today)\s+([A-Za-z0-9\s,:]+)/i);
      const appointmentDate = dateMatch ? dateMatch[1].trim() : undefined;

      return {
        detected: true,
        tool: aiToolRegistry.getTool("createAppointmentTool"),
        parsedArguments: {
          action: "SCHEDULE_APPOINTMENT",
          appointmentDate,
          patientId: contextPatientId,
          clinicId: contextClinicId
        },
        confidence: appointmentDate ? 0.93 : 0.85
      };
    }

    return { detected: false, confidence: 0 };
  }
}

export const aiToolRouter = AIToolRouter.getInstance();


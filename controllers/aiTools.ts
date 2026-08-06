import type { FastifyRequest, FastifyReply } from "fastify";
import { AIToolExecutionLog } from "../models/AIToolExecutionLog.ts";
import { aiToolRouter } from "../services/ai/AIToolRouter.ts";
import { aiToolRegistry } from "../services/ai/AIToolRegistry.ts";
import { aiService } from "../services/ai/AIService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// ─── POST /api/ai/tools/intent ─────────────────────────────────────────
export async function detectToolIntentController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { prompt } = req.body as { prompt: string };
    const intent = aiToolRouter.detectIntent(prompt);
    return reply.code(200).send(successResponse(intent));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to detect tool intent"));
  }
}

// ─── POST /api/ai/tools/request-execution ──────────────────────────────
export async function requestToolExecutionController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { toolName, inputPayload, sessionId } = req.body as {
      toolName: string;
      inputPayload: Record<string, any>;
      sessionId?: string;
    };
    const userId = req.user?.id;
    const orgId = req.user?.organization_id;

    if (!toolName || !inputPayload) {
      return reply.code(400).send(errorResponse("toolName and inputPayload are required"));
    }
    if (!userId || !orgId) {
      return reply.code(403).send(errorResponse("Authenticated organization context is required"));
    }
    const validTools = ["generateSOAPNoteTool", "createAppointmentTool", "prescribeMedicationTool"];
    if (!validTools.includes(toolName)) {
      return reply.code(400).send(errorResponse("Unknown or unsupported AI tool"));
    }

    if (toolName === "generateSOAPNoteTool") {
      if (typeof inputPayload.chiefComplaint !== "string" || !inputPayload.chiefComplaint.trim()) {
        return reply.code(400).send(errorResponse("chiefComplaint is required for SOAP note generation"));
      }
    } else if (toolName === "createAppointmentTool") {
      if (!inputPayload.patientId || !inputPayload.doctorId || !inputPayload.clinicId) {
        return reply.code(400).send(errorResponse("patientId, doctorId, and clinicId are required for appointment creation"));
      }
    } else if (toolName === "prescribeMedicationTool") {
      if (!inputPayload.patientId || !inputPayload.clinicId || !inputPayload.medicineName) {
        return reply.code(400).send(errorResponse("patientId, clinicId, and medicineName are required for prescription creation"));
      }
    }

    const log = await AIToolExecutionLog.create({
      organizationId: orgId,
      requestedByUserId: userId,
      sessionId: sessionId || "general",
      toolName,
      inputPayload,
      status: "pending_approval"
    });

    return reply.code(201).send(successResponse(log, "Tool action logged awaiting clinician e-signature approval"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Failed to log tool execution request"));
  }
}

// ─── PUT /api/ai/tools/:id/approve ─────────────────────────────────────
export async function approveAndExecuteToolController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };

    if (!req.user?.id || !req.user.organization_id) {
      return reply.code(403).send(errorResponse("Authenticated organization context is required"));
    }

    const log = await AIToolExecutionLog.findOne({
      _id: id,
      organizationId: req.user.organization_id,
    });
    if (!log) {
      return reply.code(404).send(errorResponse("Tool execution record not found"));
    }
    if (log.status !== "pending_approval") {
      return reply.code(409).send(errorResponse("Tool execution is no longer awaiting approval"));
    }

    const input = log.inputPayload as Record<string, any>;
    let result: any = null;

    if (log.toolName === "generateSOAPNoteTool") {
      if (typeof input?.chiefComplaint !== "string" || !input.chiefComplaint.trim()) {
        return reply.code(400).send(errorResponse("chiefComplaint is required for SOAP note generation"));
      }

      result = await aiService.generateSOAPNote({
        chiefComplaint: input.chiefComplaint.trim(),
        vitals: input.vitals,
        examinationFindings: input.examinationFindings,
        history: input.history,
      });
    } else if (log.toolName === "createAppointmentTool") {
      const { Appointment } = await import("../models/Appointment.ts");
      const apptTime = input.appointmentDate || input.appointmentTime || new Date();
      const count = await Appointment.countDocuments({ clinicId: input.clinicId });

      result = await Appointment.create({
        clinicId: input.clinicId,
        doctorId: input.doctorId,
        patientId: input.patientId,
        appointmentTime: new Date(apptTime),
        appointmentType: input.type || "online",
        status: "confirmed",
        tokenNumber: count + 1,
        notes: input.notes || "Created via Clinician-Approved AI Copilot",
      });
    } else if (log.toolName === "prescribeMedicationTool") {
      const { Prescription } = await import("../models/Prescription.ts");
      const { Encounter } = await import("../models/Encounter.ts");

      let encounterId = input.encounterId;
      if (!encounterId) {
        // Find or create active encounter for patient
        const existingEncounter = await Encounter.findOne({
          patientId: input.patientId,
          organizationId: req.user.organization_id,
          status: { $ne: "completed" },
        });
        if (existingEncounter) {
          encounterId = existingEncounter._id;
        } else {
          const newEncounter = await Encounter.create({
            organizationId: req.user.organization_id,
            clinicId: input.clinicId,
            patientId: input.patientId,
            doctorId: req.user.id,
            type: "outpatient",
            status: "in-progress",
            startedAt: new Date(),
          });
          encounterId = newEncounter._id;
        }
      }

      result = await Prescription.create({
        organizationId: req.user.organization_id,
        clinicId: input.clinicId,
        encounterId,
        patientId: input.patientId,
        doctorId: req.user.id,
        medicineName: input.medicationName || input.medicineName,
        dosage: input.dosage || "1 tab",
        frequency: input.frequency || "1-0-1",
        duration: input.duration || "5 days",
        instructions: input.instructions || "Take as directed",
        status: "active",
      });
    } else {
      return reply.code(400).send(errorResponse("Unsupported AI tool execution requested"));
    }

    log.status = "approved_and_executed";
    log.approvedByUserId = req.user?.id as any;
    log.executionResult = result;
    log.executedAt = new Date();
    await log.save();

    return reply.code(200).send(successResponse(log, "Tool action approved and executed cleanly"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse(err.message || "Failed to approve tool action"));
  }
}

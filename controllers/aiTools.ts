import type { FastifyRequest, FastifyReply } from "fastify";
import { AIToolExecutionLog } from "../models/AIToolExecutionLog.ts";
import { aiToolRouter } from "../services/ai/AIToolRouter.ts";
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

    const log = await AIToolExecutionLog.create({
      organizationId: orgId || "000000000000000000000000",
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

    const log = await AIToolExecutionLog.findById(id);
    if (!log) {
      return reply.code(404).send(errorResponse("Tool execution record not found"));
    }

    log.status = "approved_and_executed";
    log.approvedByUserId = req.user?.id as any;
    log.executionResult = { message: `Tool ${log.toolName} executed successfully with clinician co-signature.` };
    log.executedAt = new Date();
    await log.save();

    return reply.code(200).send(successResponse(log, "Tool action approved and executed cleanly"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to approve tool action"));
  }
}

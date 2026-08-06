import type { FastifyRequest, FastifyReply } from "fastify";
import { aiAdminService } from "../services/ai/AIAdminService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

// ─── GET /api/ai/admin/config ───────────────────────────────────────────
export async function getAIAdminConfigController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
    const config = await aiAdminService.getConfig(orgId);
    return reply.code(200).send(successResponse(config, "AI organization configuration retrieved successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to retrieve AI admin configuration"));
  }
}

// ─── PUT /api/ai/admin/config ───────────────────────────────────────────
export async function updateAIAdminConfigController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
    const updates = req.body as any;
    const config = await aiAdminService.updateConfig(orgId, updates, req.user?.id);
    return reply.code(200).send(successResponse(config, "AI organization configuration updated successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to update AI admin configuration"));
  }
}

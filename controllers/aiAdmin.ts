import type { FastifyRequest, FastifyReply } from "fastify";
import { aiAdminService } from "../services/ai/AIAdminService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { resolveTargetOrganizationId, isRootRequest } from "../utilities/tenant.ts";
import { Organization } from "../models/Organization.ts";

// ─── GET /api/ai/admin/config ───────────────────────────────────────────
export async function getAIAdminConfigController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const role = req.user?.role;
    if (role !== "admin" && role !== "root") {
      return reply.code(403).send(errorResponse("Only administrators can view AI configuration"));
    }
    let orgId = await resolveTargetOrganizationId(req);
    if (!orgId && isRootRequest(req)) {
      const defaultOrg = await Organization.findOne({ isActive: { $ne: false } }).sort({ createdAt: 1 });
      if (defaultOrg) orgId = defaultOrg._id.toString();
    }
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
    const role = req.user?.role;
    if (role !== "admin" && role !== "root") {
      return reply.code(403).send(errorResponse("Only administrators can update AI configuration"));
    }
    let orgId = await resolveTargetOrganizationId(req);
    if (!orgId && isRootRequest(req)) {
      const defaultOrg = await Organization.findOne({ isActive: { $ne: false } }).sort({ createdAt: 1 });
      if (defaultOrg) orgId = defaultOrg._id.toString();
    }
    if (!orgId) return reply.code(403).send(errorResponse("Organization context is required"));
    const updates = req.body as any;

    // Security check: Only Root Super-Admin can modify PHI anonymization safety flags
    if (updates?.featureFlags?.enablePHIAnonymization !== undefined && role !== "root") {
      return reply.code(403).send(errorResponse("Only Platform Root Super-Admin can modify system PHI anonymization settings"));
    }

    const config = await aiAdminService.updateConfig(orgId, updates, req.user?.id);
    return reply.code(200).send(successResponse(config, "AI organization configuration updated successfully"));
  } catch (err: any) {
    return reply.code(500).send(errorResponse("Failed to update AI admin configuration"));
  }
}


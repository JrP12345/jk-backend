import type { FastifyReply, FastifyRequest } from "fastify";
import { loadPlatformDashboard, type DashboardRange } from "../services/platformDashboard.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function getPlatformDashboard(req: FastifyRequest, reply: FastifyReply) {
  // This view is only for the platform identity, never an impersonated workspace.
  if (req.user?.role !== "root" || req.user.impersonatedBy?.id) {
    return reply.code(403).send(errorResponse("Return to the platform account to view platform metrics"));
  }
  try {
    const { range = "30D" } = req.query as { range?: DashboardRange };
    const dashboard = await loadPlatformDashboard(range);
    return reply.header("Cache-Control", "private, no-store").send(successResponse(dashboard));
  } catch (error) {
    req.log.error({ err: error }, "Platform dashboard could not be loaded");
    return reply.code(500).send(errorResponse("Platform overview could not be loaded"));
  }
}

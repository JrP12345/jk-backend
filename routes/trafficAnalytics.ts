import type { FastifyInstance } from "fastify";
import { authenticate, requirePlatformRoot } from "../middleware/auth.ts";
import { getSiteTrafficAnalytics } from "../controllers/trafficAnalytics.ts";

export default async function trafficAnalyticsRoutes(app: FastifyInstance) {
  // GET /api/admin/analytics/traffic — Root Superadmin Live Traffic & Clinic Attribution
  app.get(
    "/api/admin/analytics/traffic",
    { preHandler: [authenticate, requirePlatformRoot()] },
    getSiteTrafficAnalytics
  );
}

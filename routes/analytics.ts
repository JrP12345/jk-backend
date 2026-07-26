import type { FastifyInstance } from "fastify";
import { authenticate, authorize, checkPermission } from "../middleware/auth.ts";
import {
  getExecutiveAnalytics,
  getClinicalSummaryAnalyticsController,
  exportAnalyticsReportController,
} from "../controllers/analytics.ts";
import { getOrganizationQualityMetricsController } from "../controllers/search.ts";

export default async function analyticsRoutes(app: FastifyInstance) {
  const adminOnly = { preHandler: [authenticate, authorize("admin")] };
  const viewAnalytics = { preHandler: [authenticate, checkPermission("VIEW_ANALYTICS")] };
  const auth = { preHandler: [authenticate] };

  // Executive & Quality Metrics Dashboard
  app.get("/api/analytics/executive", adminOnly, getExecutiveAnalytics);
  app.get("/api/analytics/quality-metrics", viewAnalytics, getOrganizationQualityMetricsController);

  // Clinical Summary & Throughput Analytics
  app.get("/api/analytics/clinical-summary", auth, getClinicalSummaryAnalyticsController);

  // Report Export (JSON / CSV)
  app.get("/api/analytics/export", auth, exportAnalyticsReportController);
}

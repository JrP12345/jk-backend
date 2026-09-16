import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { exportReport } from "../controllers/reportExport.ts";
import { reportExportSchema } from "../schemas/operations.ts";

export default async function reportExportRoutes(app: FastifyInstance) {
  const reportAccess = { preHandler: [authenticate, checkAnyPermission("VIEW_ANALYTICS", "VIEW_BILLING", "MANAGE_BILLING", "MANAGE_ORGANIZATION")] };

  app.get("/api/reports/export", { ...reportAccess, schema: reportExportSchema }, exportReport);
}

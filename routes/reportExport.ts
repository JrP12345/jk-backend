import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { exportReport } from "../controllers/reportExport.ts";

export default async function reportExportRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.get("/api/reports/export", auth, exportReport);
}

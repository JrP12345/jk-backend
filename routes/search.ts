import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import {
  searchPatientRecordController,
  getEncounterSummaryReportController,
} from "../controllers/search.ts";

export default async function searchRoutes(app: FastifyInstance) {
  const viewEhr = { preHandler: [authenticate, checkPermission("VIEW_EHR")] };

  app.get("/api/patients/:id/search", viewEhr, searchPatientRecordController);
  app.get("/api/encounters/:id/summary-report", viewEhr, getEncounterSummaryReportController);
}

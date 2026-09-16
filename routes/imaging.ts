import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkPermission, denyRoles } from "../middleware/auth.ts";
import {
  createImagingStudy,
  getImagingStudies,
  signRadiologyReport,
  updateImagingStudyStatus,
} from "../controllers/imaging.ts";
import {
  createImagingStudySchema,
  imagingStudiesQuerySchema,
  signRadiologyReportSchema,
  updateImagingStudyStatusSchema,
} from "../schemas/clinical.ts";

export default async function imagingRoutes(app: FastifyInstance) {
  const staffOnly = denyRoles("patient", "family_member", "guest");
  const viewImaging = { preHandler: [authenticate, staffOnly, checkAnyPermission("VIEW_EHR", "MANAGE_ORDERS")] };
  const manageImaging = { preHandler: [authenticate, staffOnly, checkPermission("MANAGE_ORDERS")] };
  const reportImaging = { preHandler: [authenticate, staffOnly, checkAnyPermission("MANAGE_CLINICAL_NOTES", "MANAGE_EHR")] };

  app.post("/api/radiology/studies", { ...manageImaging, schema: createImagingStudySchema }, createImagingStudy);
  app.get("/api/radiology/studies", { ...viewImaging, schema: imagingStudiesQuerySchema }, getImagingStudies);
  app.put("/api/radiology/studies/:id/status", { ...manageImaging, schema: updateImagingStudyStatusSchema }, updateImagingStudyStatus);
  app.put("/api/radiology/studies/:id/report", { ...reportImaging, schema: signRadiologyReportSchema }, signRadiologyReport);
}

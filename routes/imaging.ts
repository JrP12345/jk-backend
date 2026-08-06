import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  createImagingStudy,
  getImagingStudies,
  signRadiologyReport,
  updateImagingStudyStatus,
} from "../controllers/imaging.ts";

export default async function imagingRoutes(app: FastifyInstance) {
  app.post("/api/radiology/studies", { preHandler: [authenticate, authorize("admin", "doctor", "nurse", "receptionist")] }, createImagingStudy);
  app.get("/api/radiology/studies", { preHandler: [authenticate] }, getImagingStudies);
  app.put("/api/radiology/studies/:id/status", { preHandler: [authenticate, authorize("admin", "doctor", "nurse", "lab_tech")] }, updateImagingStudyStatus);
  app.put("/api/radiology/studies/:id/report", { preHandler: [authenticate, authorize("admin", "doctor")] }, signRadiologyReport);
}


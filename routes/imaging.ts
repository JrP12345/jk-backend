import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  createImagingStudy,
  getImagingStudies,
  signRadiologyReport,
} from "../controllers/imaging.ts";

export default async function imagingRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/radiology/studies", auth, createImagingStudy);
  app.get("/api/radiology/studies", auth, getImagingStudies);
  app.put("/api/radiology/studies/:id/report", auth, signRadiologyReport);
}

import type { FastifyInstance } from "fastify";
import {
  getHomeRPMRecords,
  createHomeRPMRecord,
  updateRPMVitals,
  updateNurseVisitStatus,
  deleteHomeRPMRecord,
} from "../controllers/homeRPM.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function homeRPMRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getHomeRPMRecords);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse")] }, createHomeRPMRecord);
  fastify.patch("/:id/vitals", { preHandler: [authorize("admin", "doctor", "nurse", "patient")] }, updateRPMVitals);
  fastify.patch("/:id/nurse-visit", { preHandler: [authorize("admin", "doctor", "nurse")] }, updateNurseVisitStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteHomeRPMRecord);
}


import type { FastifyInstance } from "fastify";
import {
  getCssdLogs,
  createSterileTrayLog,
  updateTrayStatus,
  deleteSterileTrayLog,
} from "../controllers/cssd.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function cssdRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getCssdLogs);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, createSterileTrayLog);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, updateTrayStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteSterileTrayLog);
}


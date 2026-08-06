import type { FastifyInstance } from "fastify";
import {
  getHBOTSessions,
  createHBOTSession,
  updateHBOTStatus,
  deleteHBOTSession,
} from "../controllers/hbot.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function hbotRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getHBOTSessions);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, createHBOTSession);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, updateHBOTStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteHBOTSession);
}


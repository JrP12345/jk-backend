import type { FastifyInstance } from "fastify";
import {
  getMortuaryEntries,
  createMortuaryEntry,
  updateReleaseStatus,
  deleteMortuaryEntry,
} from "../controllers/mortuary.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function mortuaryRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getMortuaryEntries);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, createMortuaryEntry);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, updateReleaseStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteMortuaryEntry);
}


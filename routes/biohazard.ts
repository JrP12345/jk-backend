import type { FastifyInstance } from "fastify";
import {
  getBiohazardLogs,
  createBiohazardLog,
  updateBiohazardStatus,
  deleteBiohazardLog,
} from "../controllers/biohazard.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function biohazardRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getBiohazardLogs);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse", "lab_tech", "receptionist")] }, createBiohazardLog);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse", "lab_tech", "receptionist")] }, updateBiohazardStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteBiohazardLog);
}


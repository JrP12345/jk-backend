import type { FastifyInstance } from "fastify";
import {
  getGeneticRecords,
  createGeneticRecord,
  updateGeneticStatus,
  deleteGeneticRecord,
} from "../controllers/genetics.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function geneticsRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getGeneticRecords);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "lab_tech")] }, createGeneticRecord);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "lab_tech")] }, updateGeneticStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteGeneticRecord);
}


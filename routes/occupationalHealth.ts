import type { FastifyInstance } from "fastify";
import {
  getOccupationalRecords,
  createOccupationalRecord,
  updateOccupationalStatus,
  deleteOccupationalRecord,
} from "../controllers/occupationalHealth.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function occupationalHealthRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getOccupationalRecords);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse")] }, createOccupationalRecord);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse")] }, updateOccupationalStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteOccupationalRecord);
}


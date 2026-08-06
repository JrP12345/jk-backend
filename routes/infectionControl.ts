import type { FastifyInstance } from "fastify";
import {
  getInfectionIncidents,
  createInfectionIncident,
  updateInfectionStatus,
  deleteInfectionIncident,
} from "../controllers/infectionControl.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function infectionControlRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getInfectionIncidents);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse")] }, createInfectionIncident);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse")] }, updateInfectionStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteInfectionIncident);
}


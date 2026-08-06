import type { FastifyInstance } from "fastify";
import {
  getTransplantCases,
  createTransplantCase,
  updateMatchStatus,
  calculateMatch,
  deleteTransplantCase,
} from "../controllers/transplant.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function transplantRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getTransplantCases);
  fastify.post("/", { preHandler: [authorize("admin", "doctor")] }, createTransplantCase);
  fastify.post("/match-calculator", { preHandler: [authorize("admin", "doctor")] }, calculateMatch);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor")] }, updateMatchStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteTransplantCase);
}

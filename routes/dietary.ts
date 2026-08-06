import type { FastifyInstance } from "fastify";
import {
  getDietOrders,
  createDietOrder,
  updateDietStatus,
  deleteDietOrder,
} from "../controllers/dietary.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function dietaryRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getDietOrders);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse")] }, createDietOrder);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse")] }, updateDietStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin", "doctor")] }, deleteDietOrder);
}


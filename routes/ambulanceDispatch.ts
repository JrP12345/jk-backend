import type { FastifyInstance } from "fastify";
import {
  getAmbulanceDispatches,
  createAmbulanceDispatch,
  updateDispatchStatus,
  updateDispatchTelemetry,
  deleteAmbulanceDispatch,
} from "../controllers/ambulanceDispatch.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function ambulanceDispatchRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getAmbulanceDispatches);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, createAmbulanceDispatch);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, updateDispatchStatus);
  fastify.post("/:id/telemetry", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, updateDispatchTelemetry);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteAmbulanceDispatch);
}


import type { FastifyInstance } from "fastify";
import {
  getShifts,
  createShift,
  updateShiftStatus,
  updateHandoverNotes,
  deleteShift,
} from "../controllers/shifts.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function shiftRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getShifts);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse")] }, createShift);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse")] }, updateShiftStatus);
  fastify.patch("/:id/handover", { preHandler: [authorize("admin", "doctor", "nurse")] }, updateHandoverNotes);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteShift);
}

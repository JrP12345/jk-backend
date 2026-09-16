import type { FastifyInstance } from "fastify";
import {
  getShifts,
  createShift,
  updateShiftStatus,
  updateHandoverNotes,
  deleteShift,
} from "../controllers/shifts.ts";
import { authenticate, checkAnyPermission, checkPermission, denyRoles } from "../middleware/auth.ts";
import {
  createShiftSchema,
  deleteShiftSchema,
  shiftsQuerySchema,
  updateShiftHandoverSchema,
  updateShiftStatusSchema,
} from "../schemas/clinical.ts";

export default async function shiftRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);
  const staffOnly = denyRoles("patient", "family_member", "guest");
  const viewShifts = { preHandler: [staffOnly, checkAnyPermission("VIEW_STAFF", "MANAGE_STAFF", "VIEW_EHR")] };
  const manageShifts = { preHandler: [staffOnly, checkAnyPermission("MANAGE_STAFF", "MANAGE_EHR", "MANAGE_CLINICAL_NOTES")] };
  const deleteShifts = { preHandler: [staffOnly, checkPermission("MANAGE_STAFF")] };

  fastify.get("/", { ...viewShifts, schema: shiftsQuerySchema }, getShifts);
  fastify.post("/", { ...manageShifts, schema: createShiftSchema }, createShift);
  fastify.patch("/:id/status", { ...manageShifts, schema: updateShiftStatusSchema }, updateShiftStatus);
  fastify.patch("/:id/handover", { ...manageShifts, schema: updateShiftHandoverSchema }, updateHandoverNotes);
  fastify.delete("/:id", { ...deleteShifts, schema: deleteShiftSchema }, deleteShift);
}

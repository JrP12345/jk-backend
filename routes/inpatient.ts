import type { FastifyInstance } from "fastify";
import { authenticate, authorize, checkPermission } from "../middleware/auth.ts";
import { createBedSchema, admitPatientSchema } from "../schemas/clinical.ts";
import {
  createBed,
  getBeds,
  updateBed,
  deleteBed,
  admitPatient,
  getAdmissions,
  dischargePatient,
} from "../controllers/admission.ts";
import {
  compileDischargeSummaryController,
  getDischargeSummaryByEncounterController,
  finalizeDischargeSummaryController,
  countersignDischargeSummaryController,
  getDischargeByIdController,
} from "../controllers/discharge.ts";

export default async function inpatientRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const adminOnly = { preHandler: [authenticate, authorize("admin")] };
  const manageDischarge = { preHandler: [authenticate, checkPermission("MANAGE_DISCHARGE_SUMMARY")] };
  const viewEhr = { preHandler: [authenticate, checkPermission("VIEW_EHR")] };

  // Beds
  app.post("/api/beds", { ...adminOnly, schema: createBedSchema }, createBed);
  app.get("/api/beds", auth, getBeds);
  app.put("/api/beds/:id", adminOnly, updateBed);
  app.delete("/api/beds/:id", adminOnly, deleteBed);

  // Admissions
  app.post("/api/admissions", { ...auth, schema: admitPatientSchema }, admitPatient);
  app.get("/api/admissions", auth, getAdmissions);
  app.put("/api/admissions/:id/discharge", auth, dischargePatient);

  // Inpatient Discharge Summary
  app.post("/api/encounters/:id/discharge/compile", manageDischarge, compileDischargeSummaryController);
  app.get("/api/encounters/:id/discharge", viewEhr, getDischargeSummaryByEncounterController);
  app.put("/api/discharge/:id/finalize", manageDischarge, finalizeDischargeSummaryController);
  app.put("/api/discharge/:id/countersign", manageDischarge, countersignDischargeSummaryController);
  app.get("/api/discharge/:id", viewEhr, getDischargeByIdController);
}

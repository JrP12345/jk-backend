import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { createMedicineSchema, dispensePrescriptionSchema } from "../schemas/clinical.ts";
import {
  createMedicine,
  getMedicines,
  updateMedicine,
  deleteMedicine,
  dispensePrescription,
  getPendingPrescriptionsController,
  createMedicineBatch,
  getMedicineBatches,
  getExpiringMedicinesController,
  adjustStock,
} from "../controllers/medicine.ts";

export default async function pharmacyRoutes(app: FastifyInstance) {
  const viewPharmacy = {
    preHandler: [authenticate, requireModule("pharmacy"), checkAnyPermission("MANAGE_MEDICINES", "VIEW_EHR")],
  };
  const managePharmacy = {
    preHandler: [authenticate, requireModule("pharmacy"), checkPermission("MANAGE_MEDICINES")],
  };

  app.post("/api/medicines", { ...managePharmacy, schema: createMedicineSchema }, createMedicine);
  app.get("/api/medicines", viewPharmacy, getMedicines);
  app.put("/api/medicines/:id", managePharmacy, updateMedicine);
  app.delete("/api/medicines/:id", managePharmacy, deleteMedicine);
  app.post("/api/pharmacy/dispense", { ...managePharmacy, schema: dispensePrescriptionSchema }, dispensePrescription);
  app.get("/api/pharmacy/pending-prescriptions", viewPharmacy, getPendingPrescriptionsController);
  app.get("/api/pharmacy/prescriptions/pending", viewPharmacy, getPendingPrescriptionsController);
  app.post("/api/pharmacy/adjust-stock", managePharmacy, adjustStock);

  // Multi-Batch & Expiration Tracking
  app.post("/api/pharmacy/batches", managePharmacy, createMedicineBatch);
  app.get("/api/pharmacy/medicines/:id/batches", viewPharmacy, getMedicineBatches);
  app.get("/api/pharmacy/expiring", viewPharmacy, getExpiringMedicinesController);
}

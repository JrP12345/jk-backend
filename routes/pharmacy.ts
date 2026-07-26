import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import { createMedicineSchema, dispensePrescriptionSchema } from "../schemas/clinical.ts";
import {
  createMedicine,
  getMedicines,
  updateMedicine,
  deleteMedicine,
  dispensePrescription,
} from "../controllers/medicine.ts";

export default async function pharmacyRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const adminOnly = { preHandler: [authenticate, authorize("admin")] };

  app.post("/api/medicines", { ...adminOnly, schema: createMedicineSchema }, createMedicine);
  app.get("/api/medicines", auth, getMedicines);
  app.put("/api/medicines/:id", adminOnly, updateMedicine);
  app.delete("/api/medicines/:id", adminOnly, deleteMedicine);
  app.post("/api/pharmacy/dispense", { ...auth, schema: dispensePrescriptionSchema }, dispensePrescription);
}

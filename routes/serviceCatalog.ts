import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  createService,
  getServices,
  getServiceById,
  updateService,
  deleteService,
  seedDefaultServices,
} from "../controllers/serviceCatalog.ts";

export default async function serviceCatalogRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const staffAuth = { preHandler: [authenticate, authorize(["admin", "root", "receptionist", "cashier"])] };

  app.get("/api/service-catalog", auth, getServices);
  app.get("/api/service-catalog/:id", auth, getServiceById);
  app.post("/api/service-catalog", staffAuth, createService);
  app.put("/api/service-catalog/:id", staffAuth, updateService);
  app.delete("/api/service-catalog/:id", staffAuth, deleteService);
  app.post("/api/service-catalog/seed", staffAuth, seedDefaultServices);
}

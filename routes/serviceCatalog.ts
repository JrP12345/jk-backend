import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import {
  createService,
  getServices,
  getServiceById,
  updateService,
  deleteService,
  seedDefaultServices,
} from "../controllers/serviceCatalog.ts";

export default async function serviceCatalogRoutes(app: FastifyInstance) {
  const viewCatalog = {
    preHandler: [
      authenticate,
      requireModule("billing"),
      checkAnyPermission("VIEW_BILLING", "MANAGE_BILLING"),
    ],
  };
  const manageCatalog = {
    preHandler: [
      authenticate,
      requireModule("billing"),
      checkPermission("MANAGE_BILLING"),
    ],
  };

  app.get("/api/service-catalog", viewCatalog, getServices);
  app.get("/api/service-catalog/:id", viewCatalog, getServiceById);
  app.post("/api/service-catalog", manageCatalog, createService);
  app.put("/api/service-catalog/:id", manageCatalog, updateService);
  app.delete("/api/service-catalog/:id", manageCatalog, deleteService);
  app.post("/api/service-catalog/seed", manageCatalog, seedDefaultServices);
}

import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  getModules,
  toggleModule,
  bulkToggleModules,
  seedModulesEndpoint,
} from "../controllers/moduleRegistry.ts";

export default async function moduleRegistryRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const adminOnly = { preHandler: [authenticate, authorize("admin")] };
  const rootOnly = { preHandler: [authenticate, authorize("root")] };

  // Any authenticated user can read module states (needed for sidebar filtering)
  app.get("/api/modules", auth, getModules);

  // Admin or Root can toggle modules
  // IMPORTANT: bulk route must be registered BEFORE :moduleKey to avoid route conflict
  app.put("/api/modules/bulk", adminOnly, bulkToggleModules);
  app.put("/api/modules/:moduleKey", adminOnly, toggleModule);

  // Root-only: seed modules for a specific org
  app.post("/api/modules/seed", rootOnly, seedModulesEndpoint);
}

import type { FastifyInstance } from "fastify";
import { authenticate, requirePlatformRoot } from "../middleware/auth.ts";
import {
  getModules,
  toggleModule,
  bulkToggleModules,
  seedModulesEndpoint,
} from "../controllers/moduleRegistry.ts";

export default async function moduleRegistryRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const rootOnly = { preHandler: [authenticate, requirePlatformRoot()] };

  // Any authenticated user can read module states (needed for sidebar filtering)
  app.get("/api/modules", auth, getModules);

  // Only Root super-admin can toggle modules
  // IMPORTANT: bulk route must be registered BEFORE :moduleKey to avoid route conflict
  app.put("/api/modules/bulk", rootOnly, bulkToggleModules);
  app.put("/api/modules/:moduleKey", rootOnly, toggleModule);

  // Root-only: seed modules for a specific org
  app.post("/api/modules/seed", rootOnly, seedModulesEndpoint);
}

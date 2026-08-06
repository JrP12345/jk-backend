import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  getRoles,
  getPermissionCatalog,
  createRole,
  updateRolePermissions,
  deleteRole,
  updateUserRole,
} from "../controllers/role.ts";

export default async function roleRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };
  const adminAuth = { preHandler: [authenticate, authorize("admin", "root")] };

  // Roles & Permissions Endpoints
  app.get("/api/roles", auth, getRoles);
  app.get("/api/permissions", auth, getPermissionCatalog);
  app.post("/api/roles", adminAuth, createRole);
  app.put("/api/roles/:name", adminAuth, updateRolePermissions);
  app.delete("/api/roles/:name", adminAuth, deleteRole);
  app.put("/api/users/:id/role", adminAuth, updateUserRole);
}

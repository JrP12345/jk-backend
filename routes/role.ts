import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
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
  const manageRoles = { preHandler: [authenticate, checkPermission("ADMINISTRATIVE_GOVERNANCE")] };

  // Roles & Permissions Endpoints
  app.get("/api/roles", auth, getRoles);
  app.get("/api/permissions", auth, getPermissionCatalog);
  app.post("/api/roles", manageRoles, createRole);
  app.put("/api/roles/:name", manageRoles, updateRolePermissions);
  app.delete("/api/roles/:name", manageRoles, deleteRole);
  app.put("/api/users/:id/role", manageRoles, updateUserRole);
}

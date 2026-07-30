import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  createPreAuthRequest,
  getPreAuthList,
  updatePreAuthStatus,
} from "../controllers/preAuth.ts";

export default async function preAuthRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/insurance/pre-auth", auth, createPreAuthRequest);
  app.get("/api/insurance/pre-auth", auth, getPreAuthList);
  app.put("/api/insurance/pre-auth/:id/status", auth, updatePreAuthStatus);
}

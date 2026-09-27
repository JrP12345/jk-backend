import type { FastifyInstance } from "fastify";
import { authenticate, requirePlatformRoot } from "../middleware/auth.ts";

/** Operational manifest; developer API-key authentication is not implemented. */
export default async function platformGatewayRoutes(app: FastifyInstance) {
  app.get("/manifest", { preHandler: [authenticate, requirePlatformRoot()] }, async () => ({
    platform: "Ekavyu Healthcare", version: "1.0.0",
    apis: { auth: "/api/auth", appointments: "/api/appointments", encounters: "/api/encounters", documents: "/api/documents", abdm: "/api/abdm" },
  }));
}

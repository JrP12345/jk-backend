import type { FastifyInstance } from "fastify";
import { initiateSsoRedirect, handleSsoCallback } from "../controllers/sso.ts";

export default async function ssoRoutes(app: FastifyInstance) {
  // Public SSO Auth Endpoints
  app.get("/api/auth/sso/initiate", initiateSsoRedirect);
  app.post("/api/auth/sso/callback", handleSsoCallback);
}

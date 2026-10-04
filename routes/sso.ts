import type { FastifyInstance } from "fastify";
import { initiateSsoRedirect, handleSsoCallback } from "../controllers/sso.ts";

export default async function ssoRoutes(app: FastifyInstance) {
  // Public SSO Auth Endpoints
  const budget = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };
  app.get("/api/auth/sso/initiate", budget, initiateSsoRedirect);
  app.post("/api/auth/sso/callback", budget, handleSsoCallback);
}

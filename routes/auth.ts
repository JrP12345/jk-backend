import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { login, registerPatient, refreshAccessToken, logout, me } from "../controllers/auth.ts";
import { loginSchema, registerPatientSchema } from "../schemas/auth.ts";
import { getJwks } from "../utilities/keys.ts";

export default async function authRoutes(app: FastifyInstance) {
  // GET /.well-known/jwks.json — Public JWKS endpoint
  app.get("/.well-known/jwks.json", async (req, reply) => {
    return reply.code(200).send(getJwks());
  });

  // POST /api/auth/login        — Login (all roles) → returns accessToken + refreshToken
  app.post("/api/auth/login", {
    schema: loginSchema,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute"
      }
    }
  }, login);

  // POST /api/auth/register     — Patient self-registration → returns accessToken + refreshToken
  app.post("/api/auth/register", {
    schema: registerPatientSchema,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute"
      }
    }
  }, registerPatient);

  // POST /api/auth/refresh      — Exchange refreshToken for a new accessToken
  app.post("/api/auth/refresh", refreshAccessToken);

  // POST /api/auth/logout       — Revoke all refresh tokens (and unconditionally clear cookies)
  app.post("/api/auth/logout", logout);

  // GET /api/auth/me            — Get current authenticated user details
  app.get("/api/auth/me", { preHandler: [authenticate] }, me);
}

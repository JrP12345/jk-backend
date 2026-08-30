import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  requestOtpController,
  verifyOtpController,
  guestLoginController,
  login,
  verifyLoginTwoFactor,
  registerPatient,
  refreshAccessToken,
  logout,
  me,
  switchOrganization,
  verifyEmail,
  forgotPassword,
  resetPassword,
  getActiveSessions,
  revokeSession,
} from "../controllers/auth.ts";
import { loginSchema, registerPatientSchema } from "../schemas/auth.ts";
import { getJwks } from "../utilities/keys.ts";

export default async function authRoutes(app: FastifyInstance) {
  const isTest = process.env.NODE_ENV === "test";

  // GET /.well-known/jwks.json — Public JWKS endpoint
  app.get("/.well-known/jwks.json", async (req, reply) => {
    return reply.code(200).send(getJwks());
  });

  // Direct Guest / Passwordless Login without OTP
  app.post("/api/auth/guest", {
    config: {
      rateLimit: {
        max: isTest ? 1000 : 20,
        timeWindow: "1 minute"
      }
    }
  }, guestLoginController);

  app.post("/api/auth/guest-login", {
    config: {
      rateLimit: {
        max: isTest ? 1000 : 20,
        timeWindow: "1 minute"
      }
    }
  }, guestLoginController);

  // OTP Passwordless Authentication
  app.post("/api/auth/otp/request", {
    config: {
      rateLimit: {
        max: isTest ? 1000 : 5,
        timeWindow: "1 minute"
      }
    }
  }, requestOtpController);

  app.post("/api/auth/otp/verify", {
    config: {
      rateLimit: {
        max: isTest ? 1000 : 10,
        timeWindow: "1 minute"
      }
    }
  }, verifyOtpController);

  // POST /api/auth/login        — Login (all roles) → returns accessToken + refreshToken
  app.post("/api/auth/login", {
    schema: loginSchema,
    config: {
      rateLimit: {
        max: isTest ? 1000 : 5,
        timeWindow: "1 minute"
      }
    }
  }, login);

  app.post("/api/auth/login/verify-2fa", {
    schema: {
      body: {
        type: "object",
        required: ["twoFactorToken", "otp"],
        properties: {
          twoFactorToken: { type: "string", minLength: 1 },
          otp: { type: "string", pattern: "^[0-9]{6}$" },
        },
        additionalProperties: false,
      },
    },
    config: {
      rateLimit: {
        max: isTest ? 1000 : 5,
        timeWindow: "1 minute",
      },
    },
  }, verifyLoginTwoFactor);

  // POST /api/auth/register     — Patient self-registration → returns accessToken + refreshToken
  app.post("/api/auth/register", {
    schema: registerPatientSchema,
    config: {
      rateLimit: {
        max: isTest ? 1000 : 5,
        timeWindow: "1 minute"
      }
    }
  }, registerPatient);

  // Identity lifecycle routes
  app.post("/api/auth/verify-email", verifyEmail);
  app.post("/api/auth/forgot-password", { config: { rateLimit: { max: isTest ? 1000 : 3, timeWindow: "1 minute" } } }, forgotPassword);
  app.post("/api/auth/reset-password", { config: { rateLimit: { max: isTest ? 1000 : 3, timeWindow: "1 minute" } } }, resetPassword);

  // Session Device Management
  app.get("/api/auth/sessions", { preHandler: [authenticate] }, getActiveSessions);
  app.delete("/api/auth/sessions/:sessionId", { preHandler: [authenticate] }, revokeSession);

  // POST /api/auth/refresh      — Exchange refreshToken for a new accessToken
  app.post("/api/auth/refresh", refreshAccessToken);

  // POST /api/auth/logout       — Revoke all refresh tokens (and unconditionally clear cookies)
  app.post("/api/auth/logout", logout);

  // GET /api/auth/me            — Get current authenticated user details
  app.get("/api/auth/me", { preHandler: [authenticate] }, me);

  // POST /api/auth/switch-org   — Switch active organization context (Root Admin only)
  app.post("/api/auth/switch-org", { preHandler: [authenticate] }, switchOrganization);
}

import type { FastifyInstance } from "fastify";
import { pharmacyOnboardingController } from "../controllers/pharmacyOnboarding.ts";

/** Public identity challenges grant only this caller's new-business setup, never an operational bypass. */
export default async function pharmacyOnboardingRoutes(app: FastifyInstance) {
  app.get("/api/pharmacy/onboarding/options", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, pharmacyOnboardingController("options"));
  for (const stage of ["start", "resend", "verify", "status", "complete"] as const) {
    app.post(`/api/pharmacy/onboarding/${stage}`, { config: { rateLimit: { max: stage === "start" || stage === "resend" ? 5 : 20, timeWindow: "10 minutes" } } }, pharmacyOnboardingController(stage));
  }
}

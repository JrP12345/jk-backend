import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { evaluatePecClaim } from "../controllers/pec.ts";

export default async function pecRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/insurance/pec/evaluate", auth, evaluatePecClaim);
}

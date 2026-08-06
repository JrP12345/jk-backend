import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { checkCdsSafety, getCdsEvaluations, getCdsRules } from "../controllers/cds.ts";

export default async function cdsRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/clinical/cds/check", auth, checkCdsSafety);
  app.get("/api/clinical/cds/evaluations", auth, getCdsEvaluations);
  app.get("/api/clinical/cds/rules", auth, getCdsRules);
}

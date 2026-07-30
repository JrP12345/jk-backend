import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { checkCdsSafety } from "../controllers/cds.ts";

export default async function cdsRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/clinical/cds/check", auth, checkCdsSafety);
}

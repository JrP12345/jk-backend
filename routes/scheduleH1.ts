import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission, checkAnyPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { getScheduleH1Entries, exportScheduleH1Register } from "../controllers/scheduleH1.ts";

export default async function scheduleH1Routes(fastify: FastifyInstance) {
  fastify.get(
    "/api/pharmacy/schedule-h1-register",
    {
      preHandler: [authenticate, requireModule("pharmacy"), checkAnyPermission("MANAGE_MEDICINES", "VIEW_EHR")],
    },
    getScheduleH1Entries
  );

  fastify.get(
    "/api/pharmacy/schedule-h1-register/export",
    {
      preHandler: [authenticate, requireModule("pharmacy"), checkPermission("MANAGE_MEDICINES")],
    },
    exportScheduleH1Register
  );
}

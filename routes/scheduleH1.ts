import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { requirePharmacyStaff, requirePharmacyAction } from "../middleware/pharmacyGuard.ts";
import { getScheduleH1Entries, exportScheduleH1Register } from "../controllers/scheduleH1.ts";

export default async function scheduleH1Routes(fastify: FastifyInstance) {
  fastify.get(
    "/api/pharmacy/schedule-h1-register",
    {
      preHandler: [authenticate, requirePharmacyStaff, requireModule("pharmacy"), requirePharmacyAction("readRegister")],
    },
    getScheduleH1Entries
  );

  fastify.get(
    "/api/pharmacy/schedule-h1-register/export",
    {
      preHandler: [authenticate, requirePharmacyStaff, requireModule("pharmacy"), requirePharmacyAction("exportRegister")],
    },
    exportScheduleH1Register
  );
}

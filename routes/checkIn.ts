import type { FastifyInstance } from "fastify";
import { processSelfCheckInQr } from "../controllers/checkIn.ts";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";

export default async function checkInRoutes(app: FastifyInstance) {
  // A clinic kiosk is an operational staff surface, not a public appointment
  // credential. Patient self check-in uses the capability-protected tracker
  // endpoint instead: POST /api/public/track/:appointmentId/check-in.
  app.post(
    "/api/check-in/qr",
    { preHandler: [authenticate, requireModule("appointments"), checkPermission("MANAGE_QUEUE")] },
    processSelfCheckInQr,
  );
}

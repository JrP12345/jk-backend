import type { FastifyInstance } from "fastify";
import { processSelfCheckInQr } from "../controllers/checkIn.ts";

export default async function checkInRoutes(app: FastifyInstance) {
  // Public / Kiosk endpoint for patient self check-in
  app.post("/api/check-in/qr", processSelfCheckInQr);
}

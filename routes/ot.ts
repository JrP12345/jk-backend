import type { FastifyInstance } from "fastify";
import { authenticate, authorize } from "../middleware/auth.ts";
import {
  createSurgicalBooking,
  getSurgicalBookings,
  updateSurgicalBookingStatus,
} from "../controllers/ot.ts";

export default async function otRoutes(app: FastifyInstance) {
  app.post("/api/ot/bookings", { preHandler: [authenticate, authorize("admin", "doctor", "nurse")] }, createSurgicalBooking);
  app.get("/api/ot/bookings", { preHandler: [authenticate] }, getSurgicalBookings);
  app.put("/api/ot/bookings/:id/status", { preHandler: [authenticate, authorize("admin", "doctor", "nurse")] }, updateSurgicalBookingStatus);
}


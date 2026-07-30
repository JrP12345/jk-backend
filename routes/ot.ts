import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  createSurgicalBooking,
  getSurgicalBookings,
  updateSurgicalBookingStatus,
} from "../controllers/ot.ts";

export default async function otRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/ot/bookings", auth, createSurgicalBooking);
  app.get("/api/ot/bookings", auth, getSurgicalBookings);
  app.put("/api/ot/bookings/:id/status", auth, updateSurgicalBookingStatus);
}

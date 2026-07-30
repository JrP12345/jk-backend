import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  createFacilityTransfer,
  getFacilityTransfers,
  updateTransferStatus,
} from "../controllers/facilityTransfer.ts";

export default async function facilityTransferRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.post("/api/transfers", auth, createFacilityTransfer);
  app.get("/api/transfers", auth, getFacilityTransfers);
  app.put("/api/transfers/:id/status", auth, updateTransferStatus);
}

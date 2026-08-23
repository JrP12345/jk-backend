import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  getFamilyMembers,
  addFamilyMember,
  updateFamilyMember,
  removeFamilyMember,
  claimPatientRecord,
} from "../controllers/family.ts";

export default async function familyRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.get("/api/family", auth, getFamilyMembers);
  app.post("/api/family", auth, addFamilyMember);
  app.patch("/api/family/:id", auth, updateFamilyMember);
  app.delete("/api/family/:id", auth, removeFamilyMember);
  app.post("/api/family/claim", auth, claimPatientRecord);
}

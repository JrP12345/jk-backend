import type { FastifyInstance } from "fastify";
import {
  getBiomedicalAssets,
  createBiomedicalAsset,
  updateAssetStatus,
  deleteBiomedicalAsset,
} from "../controllers/biomedical.ts";
import { authenticate, authorize } from "../middleware/auth.ts";

export default async function biomedicalRoutes(fastify: FastifyInstance) {
  fastify.addHook("onRequest", authenticate);

  fastify.get("/", getBiomedicalAssets);
  fastify.post("/", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, createBiomedicalAsset);
  fastify.patch("/:id/status", { preHandler: [authorize("admin", "doctor", "nurse", "receptionist")] }, updateAssetStatus);
  fastify.delete("/:id", { preHandler: [authorize("admin")] }, deleteBiomedicalAsset);
}


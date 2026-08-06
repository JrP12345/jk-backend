import type { FastifyInstance } from "fastify";
import { uploadDocument, getPatientDocuments } from "../controllers/documentUpload.ts";
import { authenticate } from "../middleware/auth.ts";

export default async function documentRoutes(fastify: FastifyInstance) {
  fastify.post(
    "/api/v1/documents/upload",
    { preHandler: [authenticate] },
    uploadDocument
  );

  fastify.get(
    "/api/v1/documents/patient/:patientId",
    { preHandler: [authenticate] },
    getPatientDocuments
  );
}

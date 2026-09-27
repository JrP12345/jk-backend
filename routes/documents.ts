import type { FastifyInstance } from "fastify";
import { uploadDocument, getPatientDocuments } from "../controllers/documentUpload.ts";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";

export default async function documentRoutes(fastify: FastifyInstance) {
  const viewDocuments = {
    preHandler: [
      authenticate,
      requireModule("patients"),
      checkAnyPermission("VIEW_PATIENTS", "VIEW_EHR", "MANAGE_PATIENTS"),
    ],
  };
  const uploadDocuments = {
    preHandler: [
      authenticate,
      requireModule("patients"),
      checkAnyPermission("MANAGE_PATIENTS", "VIEW_EHR", "MANAGE_CLINICAL_NOTES"),
    ],
  };

  fastify.post(
    "/api/documents/upload",
    uploadDocuments,
    uploadDocument
  );

  fastify.get(
    "/api/documents/patient/:patientId",
    viewDocuments,
    getPatientDocuments
  );
}

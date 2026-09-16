import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import {
  getSoapTemplates,
  createSoapTemplate,
  seedDefaultSoapTemplates,
} from "../controllers/soapTemplate.ts";

export default async function soapTemplateRoutes(app: FastifyInstance) {
  const clinicalTemplateAccess = { preHandler: [authenticate, checkAnyPermission("VIEW_EHR", "MANAGE_EHR", "MANAGE_CLINICAL_NOTES")] };
  const manageClinicalTemplates = { preHandler: [authenticate, checkAnyPermission("MANAGE_EHR", "MANAGE_CLINICAL_NOTES")] };

  app.get("/api/soap-templates", clinicalTemplateAccess, getSoapTemplates);
  app.post("/api/soap-templates", manageClinicalTemplates, createSoapTemplate);
  app.post("/api/soap-templates/seed", manageClinicalTemplates, seedDefaultSoapTemplates);
}

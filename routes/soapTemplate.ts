import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  getSoapTemplates,
  createSoapTemplate,
  seedDefaultSoapTemplates,
} from "../controllers/soapTemplate.ts";

export default async function soapTemplateRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  app.get("/api/soap-templates", auth, getSoapTemplates);
  app.post("/api/soap-templates", auth, createSoapTemplate);
  app.post("/api/soap-templates/seed", auth, seedDefaultSoapTemplates);
}

import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  getFhirPatientResource,
  getFhirObservationResource,
  getFhirDiagnosticReportResource,
} from "../controllers/fhir.ts";

export default async function fhirRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // HL7 FHIR R4 Interoperability Gateway Endpoints
  app.get("/api/fhir/R4/Patient/:id", auth, getFhirPatientResource);
  app.get("/api/fhir/R4/Observation/:id", auth, getFhirObservationResource);
  app.get("/api/fhir/R4/DiagnosticReport/:id", auth, getFhirDiagnosticReportResource);
}

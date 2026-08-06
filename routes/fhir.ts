import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import {
  getFhirPatientResource,
  getFhirObservationResource,
  getFhirDiagnosticReportResource,
  getFhirEncounterResource,
  getFhirMedicationAdministrationResource,
  getFhirCompositionResource,
  exportFhirEncounterBundleResource,
  getFhirBundleResource,
} from "../controllers/fhir.ts";

export default async function fhirRoutes(app: FastifyInstance) {
  const auth = { preHandler: [authenticate] };

  // HL7 FHIR R4 Interoperability Gateway Endpoints
  app.get("/api/fhir/R4/Patient/:id", auth, getFhirPatientResource);
  app.get("/api/fhir/R4/Observation/:id", auth, getFhirObservationResource);
  app.get("/api/fhir/R4/DiagnosticReport/:id", auth, getFhirDiagnosticReportResource);

  app.get("/api/fhir/R4/Encounter/:id", auth, getFhirEncounterResource);
  app.get("/api/fhir/R4/MedicationAdministration/:id", auth, getFhirMedicationAdministrationResource);
  app.get("/api/fhir/R4/Composition/:id", auth, getFhirCompositionResource);
  app.get("/api/fhir/R4/Encounter/:id/$export", auth, exportFhirEncounterBundleResource);
  app.get("/api/fhir/R4/Bundle/:patientId", auth, getFhirBundleResource);
}

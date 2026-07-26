import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import {
  getFHIRPatientController,
  getFHIREncounterController,
  getFHIRObservationController,
  exportFHIREncounterBundleController,
  getFHIRDiagnosticReportController,
  getFHIRMedicationAdministrationController,
  getFHIRCompositionController,
} from "../controllers/fhir.ts";

export default async function fhirRoutes(app: FastifyInstance) {
  const viewEhr = { preHandler: [authenticate, checkPermission("VIEW_EHR")] };

  app.get("/api/fhir/R4/Patient/:id", viewEhr, getFHIRPatientController);
  app.get("/api/fhir/R4/Encounter/:id", viewEhr, getFHIREncounterController);
  app.get("/api/fhir/R4/Observation/:id", viewEhr, getFHIRObservationController);
  app.get("/api/fhir/R4/Encounter/:id/$export", viewEhr, exportFHIREncounterBundleController);
  app.get("/api/fhir/R4/DiagnosticReport/:id", viewEhr, getFHIRDiagnosticReportController);
  app.get("/api/fhir/R4/MedicationAdministration/:id", viewEhr, getFHIRMedicationAdministrationController);
  app.get("/api/fhir/R4/Composition/:id", viewEhr, getFHIRCompositionController);
}

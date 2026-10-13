import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { consentCommandSchema, privacyRequestSchema, privacyReviewSchema } from "../schemas/privacy.ts";
import {
  exportPatientData,
  requestPatientErasure,
  getPatientConsents,
  updatePatientConsents,
  getPatientPrivacyRequest,
  reviewPatientPrivacyRequest,
  listPrivacyOrganizations,
  recordBreachIncident,
  getBreachIncidents,
  generateIncidentDPBIReport,
} from "../controllers/dpdp.ts";

export default async function dpdpRoutes(app: FastifyInstance) {
  // Guard for patient self-service or authorized staff
  const patientDataRights = {
    preHandler: [
      authenticate,
    ],
  };

  // Guard for security & compliance officers managing breaches
  const complianceAdmin = {
    preHandler: [
      authenticate,
      checkAnyPermission("ADMINISTRATIVE_GOVERNANCE"),
    ],
  };

  // 1. Data Portability Export (Section 11)
  app.get("/api/dpdp/export", patientDataRights, exportPatientData);

  // 2. Right to Erasure with NMC 3-Year Carve-Out (Section 12 & 17)
  app.post("/api/dpdp/erasure", { ...patientDataRights, schema: privacyRequestSchema, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, requestPatientErasure);
  app.get("/api/dpdp/privacy-request", patientDataRights, getPatientPrivacyRequest);
  app.put("/api/dpdp/privacy-request/review", { ...patientDataRights, schema: privacyReviewSchema }, reviewPatientPrivacyRequest);

  // 3. Purpose Consent Ledger & Withdrawal (Section 6)
  app.get("/api/dpdp/consents", patientDataRights, getPatientConsents);
  app.get("/api/dpdp/organizations", patientDataRights, listPrivacyOrganizations);
  app.put("/api/dpdp/consents", { ...patientDataRights, schema: consentCommandSchema, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, updatePatientConsents);

  // 4. Data Breach Incident Governance (Section 8(6))
  app.post("/api/dpdp/breaches", complianceAdmin, recordBreachIncident);
  app.get("/api/dpdp/breaches", complianceAdmin, getBreachIncidents);
  app.get("/api/dpdp/breaches/:incidentId/dpbi-dossier", complianceAdmin, generateIncidentDPBIReport);
}

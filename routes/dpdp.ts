import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermissionOrRoles } from "../middleware/auth.ts";
import {
  exportPatientData,
  requestPatientErasure,
  getPatientConsents,
  updatePatientConsents,
  recordBreachIncident,
  getBreachIncidents,
  generateIncidentDPBIReport,
} from "../controllers/dpdp.ts";

export default async function dpdpRoutes(app: FastifyInstance) {
  // Guard for patient self-service or authorized staff
  const patientDataRights = {
    preHandler: [
      authenticate,
      checkAnyPermissionOrRoles(["patient", "family_member", "admin", "doctor", "root"], "VIEW_PATIENTS", "MANAGE_PATIENTS"),
    ],
  };

  // Guard for security & compliance officers managing breaches
  const complianceAdmin = {
    preHandler: [
      authenticate,
      checkAnyPermissionOrRoles(["admin", "root", "compliance_officer"], "MANAGE_CLINIC"),
    ],
  };

  // 1. Data Portability Export (Section 11)
  app.get("/api/dpdp/export", patientDataRights, exportPatientData);

  // 2. Right to Erasure with NMC 3-Year Carve-Out (Section 12 & 17)
  app.post("/api/dpdp/erasure", patientDataRights, requestPatientErasure);

  // 3. Purpose Consent Ledger & Withdrawal (Section 6)
  app.get("/api/dpdp/consents", patientDataRights, getPatientConsents);
  app.put("/api/dpdp/consents", patientDataRights, updatePatientConsents);

  // 4. Data Breach Incident Governance (Section 8(6))
  app.post("/api/dpdp/breaches", complianceAdmin, recordBreachIncident);
  app.get("/api/dpdp/breaches", complianceAdmin, getBreachIncidents);
  app.get("/api/dpdp/breaches/:incidentId/dpbi-dossier", complianceAdmin, generateIncidentDPBIReport);
}

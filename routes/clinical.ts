import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission, checkAnyPermissionOrRoles } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { getPatientTimelineController } from "../controllers/patient.ts";
import {
  createEncounterController,
  saveDraftClinicalNoteController,
  signClinicalNoteController,
  amendClinicalNoteController,
  getClinicalNoteHistoryController,
} from "../controllers/clinicalNote.ts";
import {
  evaluatePrescriptionSafetyController,
  overrideCDSEvaluationController,
} from "../controllers/prescriptionSafety.ts";
import {
  evaluateEncounterScoreController,
  getEncounterScoresController,
  acknowledgeAlertController,
  getPatientVitalTrendsController,
} from "../controllers/observationAnalytics.ts";

export default async function clinicalRoutes(app: FastifyInstance) {
  const viewEhr = {
    preHandler: [
      authenticate,
      requireModule("consultations"),
      checkAnyPermissionOrRoles(["patient", "family_member"], "VIEW_EHR"),
    ],
  };
  const manageNotes = { preHandler: [authenticate, requireModule("consultations"), checkPermission("MANAGE_CLINICAL_NOTES")] };

  // Longitudinal EHR Timeline
  app.get("/api/patients/:id/timeline", viewEhr, getPatientTimelineController);

  // Encounters & Clinical Notes Workspace
  app.post("/api/encounters", manageNotes, createEncounterController);
  app.post("/api/clinical-notes", manageNotes, saveDraftClinicalNoteController);
  app.put("/api/clinical-notes/:id/sign", manageNotes, signClinicalNoteController);
  app.post("/api/clinical-notes/:id/amend", manageNotes, amendClinicalNoteController);
  app.get("/api/patients/:id/clinical-notes/history", viewEhr, getClinicalNoteHistoryController);

  // CDS Evaluation & Safety
  app.post("/api/prescriptions/evaluate-safety", manageNotes, evaluatePrescriptionSafetyController);
  app.post("/api/prescriptions/override-evaluation", manageNotes, overrideCDSEvaluationController);

  // Vital Signs & NEWS2 Observation Analytics
  app.post("/api/encounters/:id/evaluate-score", viewEhr, evaluateEncounterScoreController);
  app.get("/api/encounters/:id/scores", viewEhr, getEncounterScoresController);
  app.post("/api/alerts/:id/acknowledge", manageNotes, acknowledgeAlertController);
  app.get("/api/patients/:id/vital-trends", viewEhr, getPatientVitalTrendsController);

  // 1-Click OPD Clinical Presets & Custom Templates
  const { getOpdTemplates, createOpdTemplate, deleteOpdTemplate } = await import("../controllers/opdTemplate.ts");
  app.get("/api/clinical/opd-templates", { preHandler: [authenticate] }, getOpdTemplates);
  app.post("/api/clinical/opd-templates", { preHandler: [authenticate] }, createOpdTemplate);
  app.delete("/api/clinical/opd-templates/:id", { preHandler: [authenticate] }, deleteOpdTemplate);
}

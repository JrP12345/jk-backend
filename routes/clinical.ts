import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
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
  const viewEhr = { preHandler: [authenticate, checkPermission("VIEW_EHR")] };
  const manageNotes = { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] };

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
}

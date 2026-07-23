import type { FastifyInstance } from "fastify";
import { authenticate, authorize, checkPermission } from "../middleware/auth.ts";
import {
  createOrganizationSchema,
  addDoctorSchema,
  addReceptionistSchema,
  createClinicSchema,
  assignDoctorSchema
} from "../schemas/onboarding.ts";
import {
  bookAppointmentSchema,
  updateAppointmentStatusSchema
} from "../schemas/appointment.ts";
import {
  createBedSchema,
  admitPatientSchema,
  createMedicineSchema,
  dispensePrescriptionSchema,
  createLabTestSchema,
  createLabOrderSchema,
  uploadLabResultSchema
} from "../schemas/clinical.ts";
import {
  createInvoiceSchema,
  collectPaymentSchema
} from "../schemas/billing.ts";
import {
  createOrganization,
  addDoctor,
  addReceptionist,
  getOrgStaff,
  updateDoctor,
  updateReceptionist,
  deleteStaff,
  getOrganizationSettings,
  updateOrganizationSettings,
} from "../controllers/onboarding.ts";
import {
  createClinic,
  getClinics,
  updateClinic,
  deleteClinic,
} from "../controllers/clinic.ts";
import {
  assignDoctor,
  getDoctorAssignments,
  updateAssignment,
  removeAssignment,
} from "../controllers/doctorAssignment.ts";
import {
  bookAppointment,
  getAppointments,
  updateAppointmentStatus,
} from "../controllers/appointment.ts";
import {
  searchPatients,
  getPatientDetails,
  submitDoctorReview,
  getPatientTimelineController,
} from "../controllers/patient.ts";
import {
  getQueue,
  reorderQueue,
  getAuditLogs,
} from "../controllers/queue.ts";
import {
  createInvoice,
  getInvoices,
  getInvoiceDetails,
  collectPayment,
} from "../controllers/invoice.ts";
import {
  createBed,
  getBeds,
  updateBed,
  deleteBed,
  admitPatient,
  getAdmissions,
  dischargePatient,
} from "../controllers/admission.ts";
import {
  createMedicine,
  getMedicines,
  updateMedicine,
  deleteMedicine,
  dispensePrescription,
} from "../controllers/medicine.ts";
import {
  createLabTest,
  getLabTests,
  updateLabTest,
  deleteLabTest,
  createLabOrder,
  getLabOrders,
  collectSample,
  uploadLabResult,
} from "../controllers/laboratory.ts";
import {
  getExecutiveAnalytics,
} from "../controllers/analytics.ts";

export default async function onboardingRoutes(app: FastifyInstance) {
  // POST /api/onboarding/organization  — Create org + admin (public, first-time setup)
  app.post("/api/onboarding/organization", { schema: createOrganizationSchema }, createOrganization);

  // ─── Protected: Permission-based routes ─────────────────────────
  const manageStaff = { preHandler: [authenticate, checkPermission("MANAGE_STAFF")] };
  const viewStaff = { preHandler: [authenticate, checkPermission("VIEW_STAFF")] };
  const manageClinics = { preHandler: [authenticate, checkPermission("MANAGE_CLINICS")] };
  const viewClinics = { preHandler: [authenticate, checkPermission("VIEW_CLINICS")] };
  const manageOrg = { preHandler: [authenticate, checkPermission("MANAGE_ORGANIZATION")] };
  const adminOnly = { preHandler: [authenticate, authorize("admin")] };

  // POST /api/onboarding/doctor        — Admin registers a doctor
  app.post("/api/onboarding/doctor", { ...manageStaff, schema: addDoctorSchema }, addDoctor);

  // POST /api/onboarding/receptionist  — Admin registers a receptionist
  app.post("/api/onboarding/receptionist", { ...manageStaff, schema: addReceptionistSchema }, addReceptionist);

  // GET  /api/onboarding/staff         — Admin views all org staff
  app.get("/api/onboarding/staff", viewStaff, getOrgStaff);

  // PUT  /api/onboarding/doctor/:id    — Admin updates a doctor
  app.put("/api/onboarding/doctor/:id", manageStaff, updateDoctor);

  // PUT  /api/onboarding/receptionist/:id — Admin updates a receptionist
  app.put("/api/onboarding/receptionist/:id", manageStaff, updateReceptionist);

  // DELETE /api/onboarding/staff/:id   — Admin deactivates a staff member
  app.delete("/api/onboarding/staff/:id", manageStaff, deleteStaff);

  // GET /api/onboarding/organization/me — Admin views org settings
  app.get("/api/onboarding/organization/me", manageOrg, getOrganizationSettings);

  // PUT /api/onboarding/organization/me — Admin updates org settings
  app.put("/api/onboarding/organization/me", manageOrg, updateOrganizationSettings);

  // ─── Clinic CRUD Routes ──────────────────────────────────────
  app.post("/api/onboarding/clinics", { ...manageClinics, schema: createClinicSchema }, createClinic);
  app.get("/api/onboarding/clinics", viewClinics, getClinics);
  app.put("/api/onboarding/clinics/:id", manageClinics, updateClinic);
  app.delete("/api/onboarding/clinics/:id", manageClinics, deleteClinic);

  // ─── Doctor Multi-Location Assignment Routes ──────────────────
  app.post("/api/onboarding/doctors/assignments", { ...manageClinics, schema: assignDoctorSchema }, assignDoctor);
  app.get("/api/onboarding/doctors/assignments", viewClinics, getDoctorAssignments);
  app.put("/api/onboarding/doctors/assignments/:id", manageClinics, updateAssignment);
  app.delete("/api/onboarding/doctors/assignments/:id", manageClinics, removeAssignment);

  // ─── Patient Profiles & Appointment Engine ───────────────────
  app.post("/api/appointments", { preHandler: [authenticate], schema: bookAppointmentSchema }, bookAppointment);
  app.get("/api/appointments", { preHandler: [authenticate] }, getAppointments);
  app.put("/api/appointments/:id/status", { preHandler: [authenticate], schema: updateAppointmentStatusSchema }, updateAppointmentStatus);
  
  app.get("/api/patients", { preHandler: [authenticate] }, searchPatients);
  app.get("/api/patients/:id", { preHandler: [authenticate] }, getPatientDetails);
  app.post("/api/doctors/:id/reviews", { preHandler: [authenticate] }, submitDoctorReview);

  // ─── Queue Management & VIP Override Routes ─────────────────
  app.get("/api/queue", { preHandler: [authenticate] }, getQueue);
  app.put("/api/queue/reorder", { preHandler: [authenticate] }, reorderQueue);
  app.get("/api/audit-logs", { preHandler: [authenticate] }, getAuditLogs);

  // ─── Bed & Admission Routes ─────────────────────────────────
  app.post("/api/beds", { ...adminOnly, schema: createBedSchema }, createBed);
  app.get("/api/beds", { preHandler: [authenticate] }, getBeds);
  app.put("/api/beds/:id", adminOnly, updateBed);
  app.delete("/api/beds/:id", adminOnly, deleteBed);

  // app.post("/api/admissions") handles IPD admission
  app.post("/api/admissions", { preHandler: [authenticate], schema: admitPatientSchema }, admitPatient);
  app.get("/api/admissions", { preHandler: [authenticate] }, getAdmissions);
  app.put("/api/admissions/:id/discharge", { preHandler: [authenticate] }, dischargePatient);

  // ─── Medicine & Pharmacy Routes ─────────────────────────────
  app.post("/api/medicines", { ...adminOnly, schema: createMedicineSchema }, createMedicine);
  app.get("/api/medicines", { preHandler: [authenticate] }, getMedicines);
  app.put("/api/medicines/:id", adminOnly, updateMedicine);
  app.delete("/api/medicines/:id", adminOnly, deleteMedicine);
  app.post("/api/pharmacy/dispense", { preHandler: [authenticate], schema: dispensePrescriptionSchema }, dispensePrescription);

  // ─── Laboratory & Diagnostics Routes ────────────────────────
  app.post("/api/lab-tests", { ...adminOnly, schema: createLabTestSchema }, createLabTest);
  app.get("/api/lab-tests", { preHandler: [authenticate] }, getLabTests);
  app.put("/api/lab-tests/:id", adminOnly, updateLabTest);
  app.delete("/api/lab-tests/:id", adminOnly, deleteLabTest);

  app.post("/api/lab-orders", { preHandler: [authenticate], schema: createLabOrderSchema }, createLabOrder);
  app.get("/api/lab-orders", { preHandler: [authenticate] }, getLabOrders);
  app.put("/api/lab-orders/:id/sample", { preHandler: [authenticate] }, collectSample);
  app.put("/api/lab-orders/:id/result", { preHandler: [authenticate], schema: uploadLabResultSchema }, uploadLabResult);

  // ─── Billing & Payments Routes ──────────────────────────────
  app.post("/api/invoices", { preHandler: [authenticate], schema: createInvoiceSchema }, createInvoice);
  app.get("/api/invoices", { preHandler: [authenticate] }, getInvoices);
  app.get("/api/invoices/:id", { preHandler: [authenticate] }, getInvoiceDetails);
  app.put("/api/invoices/:id/pay", { preHandler: [authenticate], schema: collectPaymentSchema }, collectPayment);

  // ─── Executive Analytics Routes ─────────────────────────────
  app.get("/api/analytics/executive", adminOnly, getExecutiveAnalytics);

  // ─── Longitudinal EHR Domain Timeline Route ─────────────────
  app.get("/api/patients/:id/timeline", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, getPatientTimelineController);

  // ─── Clinical Documentation Workspace Routes ────────────────
  app.post("/api/encounters", { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] }, (await import("../controllers/clinicalNote.ts")).createEncounterController);
  app.post("/api/clinical-notes", { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] }, (await import("../controllers/clinicalNote.ts")).saveDraftClinicalNoteController);
  app.put("/api/clinical-notes/:id/sign", { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] }, (await import("../controllers/clinicalNote.ts")).signClinicalNoteController);
  app.post("/api/clinical-notes/:id/amend", { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] }, (await import("../controllers/clinicalNote.ts")).amendClinicalNoteController);
  app.get("/api/patients/:id/clinical-notes/history", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/clinicalNote.ts")).getClinicalNoteHistoryController);

  // ─── Clinical Decision Support (CDS) Routes ────────────────
  app.post("/api/prescriptions/evaluate-safety", { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] }, (await import("../controllers/prescriptionSafety.ts")).evaluatePrescriptionSafetyController);
  app.post("/api/prescriptions/override-evaluation", { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] }, (await import("../controllers/prescriptionSafety.ts")).overrideCDSEvaluationController);

  // ─── Observation Analytics & NEWS2 Scoring Routes ─────────
  app.post("/api/encounters/:id/evaluate-score", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/observationAnalytics.ts")).evaluateEncounterScoreController);
  app.get("/api/encounters/:id/scores", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/observationAnalytics.ts")).getEncounterScoresController);
  app.post("/api/alerts/:id/acknowledge", { preHandler: [authenticate, checkPermission("MANAGE_CLINICAL_NOTES")] }, (await import("../controllers/observationAnalytics.ts")).acknowledgeAlertController);
  app.get("/api/patients/:id/vital-trends", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/observationAnalytics.ts")).getPatientVitalTrendsController);

  // ─── Medication Administration Record (MAR) Routes ─────────
  // Write operations require ADMINISTER_MEDICATION (distinct from MANAGE_CLINICAL_NOTES)
  // Read operations require VIEW_EHR
  app.post("/api/encounters/:id/mar", { preHandler: [authenticate, checkPermission("ADMINISTER_MEDICATION")] }, (await import("../controllers/mar.ts")).scheduleMARController);
  app.get("/api/encounters/:id/mar", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/mar.ts")).getEncounterMARController);
  app.put("/api/mar/:id/administer", { preHandler: [authenticate, checkPermission("ADMINISTER_MEDICATION")] }, (await import("../controllers/mar.ts")).administerMARController);
  app.put("/api/mar/:id/refuse", { preHandler: [authenticate, checkPermission("ADMINISTER_MEDICATION")] }, (await import("../controllers/mar.ts")).refuseMARController);
  app.put("/api/mar/:id/hold", { preHandler: [authenticate, checkPermission("ADMINISTER_MEDICATION")] }, (await import("../controllers/mar.ts")).holdMARController);
  app.get("/api/prescriptions/:id/mar", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/mar.ts")).getPrescriptionMARController);

  // ─── Orders & Results (Diagnostic Workflow) Routes ──────────
  // Write operations require MANAGE_ORDERS; reads require VIEW_EHR
  app.post("/api/encounters/:id/orders", { preHandler: [authenticate, checkPermission("MANAGE_ORDERS")] }, (await import("../controllers/laboratory.ts")).placeOrderController);
  app.get("/api/encounters/:id/orders", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/laboratory.ts")).getEncounterOrdersController);
  app.put("/api/orders/:id/collect", { preHandler: [authenticate, checkPermission("MANAGE_ORDERS")] }, (await import("../controllers/laboratory.ts")).collectSampleOrderController);
  app.put("/api/orders/:id/process", { preHandler: [authenticate, checkPermission("MANAGE_ORDERS")] }, (await import("../controllers/laboratory.ts")).markProcessingController);
  app.put("/api/orders/:id/result", { preHandler: [authenticate, checkPermission("MANAGE_ORDERS")] }, (await import("../controllers/laboratory.ts")).recordResultController);
  app.put("/api/orders/:id/cancel", { preHandler: [authenticate, checkPermission("MANAGE_ORDERS")] }, (await import("../controllers/laboratory.ts")).cancelOrderController);

  // ─── Discharge Summary Routes ──────────────────────────────
  // Write operations require MANAGE_DISCHARGE_SUMMARY; reads require VIEW_EHR
  app.post("/api/encounters/:id/discharge/compile", { preHandler: [authenticate, checkPermission("MANAGE_DISCHARGE_SUMMARY")] }, (await import("../controllers/discharge.ts")).compileDischargeSummaryController);
  app.get("/api/encounters/:id/discharge", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/discharge.ts")).getDischargeSummaryByEncounterController);
  app.put("/api/discharge/:id/finalize", { preHandler: [authenticate, checkPermission("MANAGE_DISCHARGE_SUMMARY")] }, (await import("../controllers/discharge.ts")).finalizeDischargeSummaryController);
  app.put("/api/discharge/:id/countersign", { preHandler: [authenticate, checkPermission("MANAGE_DISCHARGE_SUMMARY")] }, (await import("../controllers/discharge.ts")).countersignDischargeSummaryController);
  app.get("/api/discharge/:id", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/discharge.ts")).getDischargeByIdController);

  // ─── Clinical Search & Analytics Routes ────────────────────
  app.get("/api/patients/:id/search", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/search.ts")).searchPatientRecordController);
  app.get("/api/encounters/:id/summary-report", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/search.ts")).getEncounterSummaryReportController);
  app.get("/api/analytics/quality-metrics", { preHandler: [authenticate, checkPermission("VIEW_ANALYTICS")] }, (await import("../controllers/search.ts")).getOrganizationQualityMetricsController);

  // ─── FHIR R4 Interoperability Routes ───────────────────────
  app.get("/api/fhir/R4/Patient/:id", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/fhir.ts")).getFHIRPatientController);
  app.get("/api/fhir/R4/Encounter/:id", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/fhir.ts")).getFHIREncounterController);
  app.get("/api/fhir/R4/Observation/:id", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/fhir.ts")).getFHIRObservationController);
  app.get("/api/fhir/R4/Encounter/:id/$export", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/fhir.ts")).exportFHIREncounterBundleController);
  app.get("/api/fhir/R4/DiagnosticReport/:id", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/fhir.ts")).getFHIRDiagnosticReportController);
  app.get("/api/fhir/R4/MedicationAdministration/:id", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/fhir.ts")).getFHIRMedicationAdministrationController);
  app.get("/api/fhir/R4/Composition/:id", { preHandler: [authenticate, checkPermission("VIEW_EHR")] }, (await import("../controllers/fhir.ts")).getFHIRCompositionController);
}





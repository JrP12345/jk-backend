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
}

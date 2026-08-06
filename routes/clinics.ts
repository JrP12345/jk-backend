import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import { createClinicSchema, assignDoctorSchema, createDepartmentSchema } from "../schemas/onboarding.ts";
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
  createDepartment,
  getDepartments,
} from "../controllers/onboarding.ts";

export default async function clinicRoutes(app: FastifyInstance) {
  const manageClinics = { preHandler: [authenticate, checkPermission("MANAGE_CLINICS")] };
  const viewClinics = { preHandler: [authenticate, checkPermission("VIEW_CLINICS")] };

  // Clinic CRUD
  app.post("/api/onboarding/clinics", { ...manageClinics, schema: createClinicSchema }, createClinic);
  app.get("/api/onboarding/clinics", viewClinics, getClinics);
  app.put("/api/onboarding/clinics/:id", manageClinics, updateClinic);
  app.delete("/api/onboarding/clinics/:id", manageClinics, deleteClinic);

  // Departments
  app.post("/api/departments", { ...manageClinics, schema: createDepartmentSchema }, createDepartment);
  app.get("/api/departments", viewClinics, getDepartments);

  // Multi-location Doctor Assignments
  app.post("/api/onboarding/doctors/assignments", { ...manageClinics, schema: assignDoctorSchema }, assignDoctor);
  app.get("/api/onboarding/doctors/assignments", viewClinics, getDoctorAssignments);
  app.put("/api/onboarding/doctors/assignments/:id", manageClinics, updateAssignment);
  app.delete("/api/onboarding/doctors/assignments/:id", manageClinics, removeAssignment);
}

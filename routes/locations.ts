import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import { requireModule } from "../middleware/moduleGuard.ts";
import { enforceSubscriptionActive } from "../middleware/subscriptionGuard.ts";
import { createLocationSchema, updateLocationSchema, assignDoctorSchema, createDepartmentSchema } from "../schemas/onboarding.ts";
import {
  createLocation,
  getLocations,
  updateLocation,
  deleteLocation,
  reactivateLocation,
  setLocationPublication,
} from "../controllers/location.ts";
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

export default async function locationRoutes(app: FastifyInstance) {
  const manageLocations = { preHandler: [authenticate, requireModule("locations"), checkPermission("MANAGE_LOCATIONS"), enforceSubscriptionActive] };
  const viewLocations = { preHandler: [authenticate, requireModule("locations"), checkPermission("VIEW_LOCATIONS")] };

  // Location CRUD
  app.post("/api/onboarding/locations", { ...manageLocations, schema: createLocationSchema }, createLocation);
  app.get("/api/onboarding/locations", viewLocations, getLocations);
  app.put("/api/onboarding/locations/:id", { ...manageLocations, schema: updateLocationSchema }, updateLocation);
  app.put("/api/onboarding/locations/:id/publication", {
    preHandler: [authenticate, checkPermission("MANAGE_LOCATIONS")],
    schema: { params: updateLocationSchema.params, body: { type: "object", required: ["isPublished"], properties: { isPublished: { type: "boolean" } }, additionalProperties: false } },
  }, setLocationPublication);
  app.delete("/api/onboarding/locations/:id", manageLocations, deleteLocation);
  app.post("/api/onboarding/locations/:id/reactivate", manageLocations, reactivateLocation);
  app.put("/api/onboarding/locations/:id/reactivate", manageLocations, reactivateLocation);

  // Departments
  app.post("/api/departments", { ...manageLocations, schema: createDepartmentSchema }, createDepartment);
  app.get("/api/departments", viewLocations, getDepartments);

  // Multi-location Doctor Assignments
  app.post("/api/onboarding/doctors/assignments", { ...manageLocations, schema: assignDoctorSchema }, assignDoctor);
  app.get("/api/onboarding/doctors/assignments", viewLocations, getDoctorAssignments);
  app.put("/api/onboarding/doctors/assignments/:id", manageLocations, updateAssignment);
  app.delete("/api/onboarding/doctors/assignments/:id", manageLocations, removeAssignment);
}

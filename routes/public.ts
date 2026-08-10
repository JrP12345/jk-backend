import type { FastifyInstance } from "fastify";
import {
  getOrganizations,
  getOrganizationDetails,
  getPublicClinics,
  getPublicClinicDetails
} from "../controllers/public.ts";

import { getDoctorSlots } from "../controllers/appointment.ts";

export default async function publicRoutes(app: FastifyInstance) {
  // GET /api/public/organizations — List all hospitals/clinics
  app.get("/api/public/organizations", getOrganizations);

  // GET /api/public/organizations/:id — Get details & doctors for a specific hospital
  app.get("/api/public/organizations/:id", getOrganizationDetails);

  // GET /api/public/clinics — List and filter active clinics
  app.get("/api/public/clinics", getPublicClinics);

  // GET /api/public/clinics/:id — Get details & assigned doctors for a specific clinic location
  app.get("/api/public/clinics/:id", getPublicClinicDetails);

  // GET /api/public/doctors/:doctorId/slots — Get slot & booking mode availability for unauthenticated guests
  app.get("/api/public/doctors/:doctorId/slots", getDoctorSlots);
}

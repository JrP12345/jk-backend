import type { FastifyInstance } from "fastify";
import {
  getOrganizations,
  getOrganizationDetails,
  getPublicClinics,
  getPublicClinicDetails,
  getPublicAppointmentTracker,
  processPublicTrackerCheckIn,
  printPublicTrackerPrescription,
  processPublicTrackerPayment,
  joinPublicQueue,
  processPublicTrackerReturn,
  getPublicQueueTv,
  trackSiteVisitController,
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

  // GET /api/public/track/:appointmentId — Public live queue tracking for patient
  app.get("/api/public/track/:appointmentId", getPublicAppointmentTracker);
  app.get("/api/public/tracker/:appointmentId", getPublicAppointmentTracker);
  app.get("/api/public/appointments/:appointmentId/tracker", getPublicAppointmentTracker);

  // POST /api/public/track/:appointmentId/check-in — Patient "I have arrived" self check-in
  app.post("/api/public/track/:appointmentId/check-in", processPublicTrackerCheckIn);

  // POST /api/public/track/:appointmentId/return — Patient "I'm back from lab/break" signal
  app.post("/api/public/track/:appointmentId/return", processPublicTrackerReturn);

  // GET /api/public/track/:appointmentId/prescription/print — Printable official prescription HTML
  app.get("/api/public/track/:appointmentId/prescription/print", printPublicTrackerPrescription);

  // Retired public settlement endpoint. Payments must use the authenticated verified payment flow.
  app.post("/api/public/track/:appointmentId/pay", processPublicTrackerPayment);

  // POST /api/public/join-queue — Fast walk-in queue join via Clinic QR Poster
  app.post("/api/public/join-queue", joinPublicQueue);

  // GET /api/public/queue-tv/:clinicId — Public Waiting Room TV display feed (kiosk/monitors)
  app.get("/api/public/queue-tv/:clinicId", getPublicQueueTv);
  app.get("/api/public/queue/tv", getPublicQueueTv);

  // POST /api/public/track-visit — Anonymous site traffic and clinic attribution tracking
  app.post("/api/public/track-visit", trackSiteVisitController);
}

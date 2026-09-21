import type { FastifyInstance } from "fastify";
import {
  getOrganizations,
  getOrganizationDetails,
  getPublicClinics,
  getPublicClinicDetails,
  getPublicAppointmentTracker,
  issuePublicTrackerCheckInCapability,
  processPublicTrackerCheckIn,
  printPublicTrackerPrescription,
  processPublicTrackerPayment,
  joinPublicQueue,
  processPublicTrackerReturn,
  getPublicQueueTv,
  trackSiteVisitController,
} from "../controllers/public.ts";

import { getDoctorSlots } from "../controllers/appointment.ts";
import { createPublicBookingSession } from "../controllers/auth.ts";

export default async function publicRoutes(app: FastifyInstance) {
  const isTest = process.env.NODE_ENV === "test";
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

  // POST /api/public/booking-session â€” OTP-free session limited to appointment creation
  app.post("/api/public/booking-session", {
    schema: {
      body: {
        type: "object",
        required: ["name", "phone"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 100 },
          phone: { type: "string", minLength: 8, maxLength: 32 },
          email: { type: "string", maxLength: 254 },
        },
        additionalProperties: false,
      },
    },
    config: {
      rateLimit: {
        max: isTest ? 1000 : 20,
        timeWindow: "1 minute",
      },
    },
  }, createPublicBookingSession);

  // GET /api/public/track/:appointmentId — Public live queue tracking for patient
  app.get("/api/public/track/:appointmentId", getPublicAppointmentTracker);
  app.get("/api/public/tracker/:appointmentId", getPublicAppointmentTracker);
  app.get("/api/public/appointments/:appointmentId/tracker", getPublicAppointmentTracker);

  // POST /api/public/track/:appointmentId/check-in — Patient "I have arrived" self check-in
  app.post("/api/public/track/:appointmentId/check-in-capability", {
    config: { rateLimit: { max: isTest ? 1000 : 10, timeWindow: "10 minutes" } },
  }, issuePublicTrackerCheckInCapability);
  app.post("/api/public/track/:appointmentId/check-in", {
    config: { rateLimit: { max: isTest ? 1000 : 10, timeWindow: "10 minutes" } },
  }, processPublicTrackerCheckIn);

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

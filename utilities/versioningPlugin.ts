import type { FastifyInstance } from "fastify";
import authRoutes from "../routes/auth.ts";
import onboardingRoutes from "../routes/onboarding.ts";
import staffRoutes from "../routes/staff.ts";
import clinicRoutes from "../routes/clinics.ts";
import appointmentRoutes from "../routes/appointments.ts";
import clinicalRoutes from "../routes/clinical.ts";
import marRoutes from "../routes/mar.ts";
import laboratoryRoutes from "../routes/laboratory.ts";
import inpatientRoutes from "../routes/inpatient.ts";
import pharmacyRoutes from "../routes/pharmacy.ts";
import billingRoutes from "../routes/billing.ts";
import analyticsRoutes from "../routes/analytics.ts";
import fhirRoutes from "../routes/fhir.ts";
import searchRoutes from "../routes/search.ts";
import publicRoutes from "../routes/public.ts";
import notificationRoutes from "../routes/notifications.ts";
import notificationPreferenceRoutes from "../routes/notificationPreferences.ts";
import taskRoutes from "../routes/tasks.ts";
import documentRoutes from "../routes/documents.ts";
import prescriptionPrintRoutes from "../routes/prescriptionPrint.ts";
import patientPortalRoutes from "../routes/patientPortal.ts";

/**
 * API v1 Versioning Plugin.
 * Mounts all core API domain routes under /api/v1 prefix for API contract versioning.
 */
export async function apiV1VersioningPlugin(app: FastifyInstance) {
  // Rewrite /api/v1/* requests to /api/* for backward compatibility & version transparency
  app.addHook("onRequest", (req, reply, done) => {
    if (req.raw.url && req.raw.url.startsWith("/api/v1/")) {
      req.raw.url = req.raw.url.replace("/api/v1/", "/api/");
    }
    done();
  });
}

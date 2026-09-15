import type { FastifyInstance } from "fastify";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import {
  generateAadhaarOtpController,
  verifyAadhaarOtpController,
  searchAbhaController,
  scanAndShareCheckInController,
  getClinicQrStandeeController,
  linkCareContextController,
  getPatientCareContextsController,
  getFhirBundleController,
  createConsentRequestController,
  getConsentStatusController,
  getExternalHealthDataController,
} from "../controllers/abdm.ts";

export default async function abdmRoutes(app: FastifyInstance) {
  const publicOtp = {
    config: { rateLimit: { max: process.env.NODE_ENV === "test" ? 1000 : 5, timeWindow: "10 minutes" } },
  };
  const clinicalAccess = {
    preHandler: [
      authenticate,
      async (req: any, reply: any) => {
        if (["patient", "family_member", "guest"].includes(req.user?.role)) {
          return reply.code(403).send({ success: false, message: "Clinical staff access is required" });
        }
      },
      checkAnyPermission("VIEW_EHR", "MANAGE_EHR", "MANAGE_CLINICAL_NOTES"),
    ],
  };
  // Public / Patient accessible ABHA generation & verification
  app.post("/api/abdm/generate-otp", publicOtp, generateAadhaarOtpController);
  app.post("/api/abdm/generate-aadhaar-otp", publicOtp, generateAadhaarOtpController);

  app.post("/api/abdm/verify-otp", publicOtp, verifyAadhaarOtpController);
  app.post("/api/abdm/verify-aadhaar-otp", publicOtp, verifyAadhaarOtpController);

  app.get("/api/abdm/search", clinicalAccess, searchAbhaController);
  app.post("/api/abdm/search-abha", clinicalAccess, searchAbhaController);

  // Clinic counter Scan & Share and Standee
  app.post("/api/abdm/scan-share", clinicalAccess, scanAndShareCheckInController);
  app.post("/api/abdm/scan-and-share", clinicalAccess, scanAndShareCheckInController);

  app.get("/api/abdm/qr-standee/:clinicId", clinicalAccess, getClinicQrStandeeController);

  // ABDM Milestone 3 (M3) HIP Care-Contexts & FHIR Bundles
  app.post("/api/abdm/care-contexts/link", clinicalAccess, linkCareContextController);
  app.get("/api/abdm/care-contexts/:patientId", clinicalAccess, getPatientCareContextsController);
  app.get("/api/abdm/fhir/encounter/:appointmentId", clinicalAccess, getFhirBundleController);

  // ABDM Milestone 3 (M3) HIU Consent & External Records
  app.post("/api/abdm/hiu/consent-request", clinicalAccess, createConsentRequestController);
  app.get("/api/abdm/hiu/consent-status/:consentRequestId", clinicalAccess, getConsentStatusController);
  app.get("/api/abdm/hiu/health-data/:consentRequestId", clinicalAccess, getExternalHealthDataController);
}

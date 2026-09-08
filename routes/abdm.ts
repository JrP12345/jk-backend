import type { FastifyInstance } from "fastify";
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
  // Public / Patient accessible ABHA generation & verification
  app.post("/api/abdm/generate-otp", generateAadhaarOtpController);
  app.post("/api/abdm/generate-aadhaar-otp", generateAadhaarOtpController);

  app.post("/api/abdm/verify-otp", verifyAadhaarOtpController);
  app.post("/api/abdm/verify-aadhaar-otp", verifyAadhaarOtpController);

  app.get("/api/abdm/search", searchAbhaController);
  app.post("/api/abdm/search-abha", searchAbhaController);

  // Clinic counter Scan & Share and Standee
  app.post("/api/abdm/scan-share", scanAndShareCheckInController);
  app.post("/api/abdm/scan-and-share", scanAndShareCheckInController);

  app.get("/api/abdm/qr-standee/:clinicId", getClinicQrStandeeController);

  // ABDM Milestone 3 (M3) HIP Care-Contexts & FHIR Bundles
  app.post("/api/abdm/care-contexts/link", linkCareContextController);
  app.get("/api/abdm/care-contexts/:patientId", getPatientCareContextsController);
  app.get("/api/abdm/fhir/encounter/:appointmentId", getFhirBundleController);

  // ABDM Milestone 3 (M3) HIU Consent & External Records
  app.post("/api/abdm/hiu/consent-request", createConsentRequestController);
  app.get("/api/abdm/hiu/consent-status/:consentRequestId", getConsentStatusController);
  app.get("/api/abdm/hiu/health-data/:consentRequestId", getExternalHealthDataController);
}


import type { FastifyRequest, FastifyReply } from "fastify";
import { abdmService } from "../services/AbdmService.ts";
import { Location } from "../models/Location.ts";
import { Appointment } from "../models/Appointment.ts";
import { Patient } from "../models/Patient.ts";
import { checkLocationAccess, checkOperationalRecordAccess, checkPatientAccess } from "../utilities/tenant.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

export async function generateAadhaarOtpController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { aadhaarNumber, phone } = (req.body || {}) as { aadhaarNumber?: string; phone?: string };

    if (!aadhaarNumber) {
      return reply.code(400).send(errorResponse("12-digit Aadhaar number is required"));
    }

    const result = await abdmService.generateAadhaarOtp(aadhaarNumber, phone);
    return reply.code(200).send(successResponse(result, "Aadhaar OTP generated successfully"));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to generate Aadhaar OTP"));
  }
}

export async function verifyAadhaarOtpController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { txnId, otp, preferredAbhaAddress, name, gender, dob } = (req.body || {}) as {
      txnId?: string;
      otp?: string;
      preferredAbhaAddress?: string;
      name?: string;
      gender?: "male" | "female" | "other";
      dob?: string;
    };

    if (!txnId || !otp) {
      return reply.code(400).send(errorResponse("txnId and 6-digit OTP are required"));
    }

    const profile = await abdmService.verifyAadhaarOtp(txnId, otp, {
      preferredAbhaAddress,
      name,
      gender,
      dob,
    });

    return reply.code(200).send(successResponse(profile, "ABHA verified and generated successfully"));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to verify Aadhaar OTP"));
  }
}

export async function searchAbhaController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const query =
      (req.query as any)?.query ||
      (req.body as any)?.query ||
      (req.body as any)?.identifier;

    if (!query) {
      return reply.code(400).send(errorResponse("Search query (ABHA Number, ABHA Address, or mobile) is required"));
    }

    const profile = await abdmService.searchAbha(query);
    if (!profile) {
      return reply.code(404).send(errorResponse("No active ABHA profile found for this identifier"));
    }

    return reply.code(200).send(successResponse(profile, "ABHA profile found"));
  } catch (err: any) {
    return reply.code(err.statusCode || 500).send(errorResponse(err.message || "Failed to search ABHA"));
  }
}

export async function scanAndShareCheckInController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId, abhaProfile, doctorId, appointmentType, notes } = (req.body || {}) as any;

    if (!locationId || !abhaProfile || !abhaProfile.abhaNumber || !doctorId) {
      return reply.code(400).send(errorResponse("locationId, doctorId, and abhaProfile with abhaNumber are required"));
    }
    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return reply.code(locationAccess.statusCode).send(errorResponse(locationAccess.message));

    const organizationId = req.user?.organization_id;

    const result = await abdmService.processScanAndShare({
      locationId,
      abhaProfile,
      doctorId,
      appointmentType: appointmentType || "qr",
      organizationId,
      notes,
    });

    return reply.code(201).send(successResponse(result, result.message));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to process ABDM Scan & Share check-in"));
  }
}

export async function getLocationQrStandeeController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { locationId } = req.params as { locationId: string };
    const locationAccess = await checkLocationAccess(req, locationId);
    if (!locationAccess.allowed) return reply.code(locationAccess.statusCode).send(errorResponse(locationAccess.message));

    const location = await Location.findById(locationId).select("name city address phone").lean();
    if (!location) {
      return reply.code(404).send(errorResponse("Location not found"));
    }

    const qrPayload = abdmService.getLocationQrStandeePayload({
      id: location._id.toString(),
      name: location.name,
      city: location.city,
    });

    return reply.code(200).send(
      successResponse(
        {
          location: {
            id: location._id.toString(),
            name: location.name,
            city: location.city,
            address: location.address,
          },
          qrPayload,
          instructions: "Patient scans this QR from Aarogya Setu / ABHA app to share demographics in 3 seconds.",
        },
        "ABDM QR standee data generated successfully"
      )
    );
  } catch (err: any) {
    return reply.code(err.statusCode || 500).send(errorResponse(err.message || "Failed to generate ABDM QR standee data"));
  }
}

// ─── ABDM Milestone 3 (M3) Controllers ──────────────────────────────────────────

export async function linkCareContextController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, appointmentId, locationId, customDisplay } = (req.body || {}) as any;

    if (!patientId || !appointmentId || !locationId) {
      return reply.code(400).send(errorResponse("patientId, appointmentId, and locationId are required"));
    }
    const [patientAccess, locationAccess] = await Promise.all([checkPatientAccess(req, patientId), checkLocationAccess(req, locationId)]);
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));
    if (!locationAccess.allowed) return reply.code(locationAccess.statusCode).send(errorResponse(locationAccess.message));
    const appointment = await Appointment.findById(appointmentId).select("patientId locationId organizationId").lean();
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));
    const appointmentAccess = await checkOperationalRecordAccess(req, appointment);
    if (!appointmentAccess.allowed || String(appointment.patientId) !== String(patientId) || String(appointment.locationId) !== String(locationId)) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const organizationId = req.user?.organization_id;
    const result = await abdmService.linkCareContext({
      patientId,
      appointmentId,
      locationId,
      organizationId,
      customDisplay,
    });

    return reply.code(200).send(successResponse(result, result.message));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to link ABDM Care-Context"));
  }
}

export async function getPatientCareContextsController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId } = req.params as { patientId: string };

    if (!patientId) {
      return reply.code(400).send(errorResponse("patientId parameter is required"));
    }
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    const result = await abdmService.getPatientCareContexts(patientId);
    return reply.code(200).send(successResponse(result, "Patient care contexts retrieved successfully"));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to retrieve care contexts"));
  }
}

export async function getFhirBundleController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { appointmentId } = req.params as { appointmentId: string };
    const { type = "prescription" } = (req.query as any) || {};

    if (!appointmentId) {
      return reply.code(400).send(errorResponse("appointmentId parameter is required"));
    }
    const appointment = await Appointment.findById(appointmentId).select("locationId organizationId").lean();
    if (!appointment) return reply.code(404).send(errorResponse("Appointment not found"));
    const appointmentAccess = await checkOperationalRecordAccess(req, appointment);
    if (!appointmentAccess.allowed) return reply.code(appointmentAccess.statusCode).send(errorResponse(appointmentAccess.message));

    const bundle = type === "diagnostic"
      ? await abdmService.generateFhirDiagnosticReportBundle(appointmentId)
      : await abdmService.generateFhirPrescriptionBundle(appointmentId);

    return reply.code(200).send(successResponse(bundle, "HL7 FHIR R4 Bundle generated successfully"));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to generate FHIR bundle"));
  }
}

export async function createConsentRequestController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { patientId, abhaAddress, purpose, hiTypes, dateFrom, dateTo } = (req.body || {}) as any;

    if (!patientId) {
      return reply.code(400).send(errorResponse("patientId is required"));
    }
    const patientAccess = await checkPatientAccess(req, patientId);
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    const result = await abdmService.createConsentRequest({
      patientId,
      abhaAddress,
      purpose,
      hiTypes,
      dateFrom,
      dateTo,
    });

    return reply.code(201).send(successResponse(result, result.message));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to create consent request"));
  }
}

export async function getConsentStatusController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { consentRequestId } = req.params as { consentRequestId: string };

    if (!consentRequestId) {
      return reply.code(400).send(errorResponse("consentRequestId parameter is required"));
    }
    const patient = await Patient.findOne({ "abdmConsentRequests.consentRequestId": consentRequestId }).select("_id").lean();
    if (!patient) return reply.code(404).send(errorResponse("Consent request not found"));
    const patientAccess = await checkPatientAccess(req, patient._id.toString());
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    const result = await abdmService.getConsentStatus(consentRequestId);
    return reply.code(200).send(successResponse(result, result.message));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to get consent status"));
  }
}

export async function getExternalHealthDataController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { consentRequestId } = req.params as { consentRequestId: string };

    if (!consentRequestId) {
      return reply.code(400).send(errorResponse("consentRequestId parameter is required"));
    }
    const patient = await Patient.findOne({ "abdmConsentRequests.consentRequestId": consentRequestId }).select("_id").lean();
    if (!patient) return reply.code(404).send(errorResponse("Consent request not found"));
    const patientAccess = await checkPatientAccess(req, patient._id.toString());
    if (!patientAccess.allowed) return reply.code(patientAccess.statusCode).send(errorResponse(patientAccess.message));

    const result = await abdmService.fetchExternalHealthData(consentRequestId);
    return reply.code(200).send(successResponse(result, "External health records fetched successfully via ABDM HIU"));
  } catch (err: any) {
    return reply.code(err.statusCode || 400).send(errorResponse(err.message || "Failed to fetch external health data"));
  }
}

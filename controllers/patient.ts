import { safeError } from "../utilities/safeError.ts";
import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import crypto from "node:crypto";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { getOrganizationPatient, hasPatientRecordAccess } from "../services/PatientRecordAccessService.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { resolveAuthorizedOrganizationScope } from "../utilities/tenant.ts";
import { patientAdministrativeDTO } from "../services/PatientAdministrativeDTO.ts";
import { requestHasAnyPermission } from "../utilities/permissions.ts";
import { CommandError } from "../services/CommandReceiptService.ts";

export async function searchPatients(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (["patient", "family_member", "guest"].includes(req.user?.role || "")) return reply.code(403).send(errorResponse("Staff access required"));
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    if (!scope.organizationId) return reply.code(403).send(errorResponse("Select an organization workspace"));
    const { search, gender, page, limit } = req.query as { search?: string; gender?: string; page?: string; limit?: string };
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const { organizationPatientPipeline } = await import("../services/PatientMatchingService.ts");
    const { PatientRelationship } = await import("../models/PatientRelationship.ts");
    const { resolveStaffLocationGrant } = await import("../services/LocationAccessService.ts");
    const { getRequestLocationIds } = await import("../utilities/tenant.ts");
    const pipeline: any[] = organizationPatientPipeline(scope.organizationId);
    const org = new mongoose.Types.ObjectId(scope.organizationId);
    pipeline.push({ $lookup: { from: User.collection.name, localField: "userId", foreignField: "_id",
      pipeline: [{ $match: { isActive: true } }, { $project: { name: 1, phone: 1, email: 1 } }], as: "linkedUser" } },
      { $set: { userId: { $arrayElemAt: ["$linkedUser", 0] } } });
    pipeline.push({ $lookup: { from: PatientRelationship.collection.name, localField: "_id", foreignField: "patientId",
      pipeline: [{ $match: { organizationId: org, status: "active" } }, { $limit: 1 }, { $project: { contact: 1, locationId: 1 } }], as: "organizationRelationship" } });
    const grant = req.user!.role === "root" ? undefined : await resolveStaffLocationGrant(req.user!.id, scope.organizationId, req.user!.role);
    if (grant !== undefined) {
      const locationIds = await getRequestLocationIds(req);
      pipeline.push({ $lookup: { from: Appointment.collection.name, localField: "_id", foreignField: "patientId", pipeline: [
        { $match: { organizationId: org, locationId: { $in: locationIds || [] } } }, { $limit: 1 }, { $project: { _id: 1 } },
      ], as: "branchVisit" } }, { $match: { $or: [{ "organizationRelationship.locationId": { $in: locationIds || [] } }, { "branchVisit.0": { $exists: true } }] } });
    }
    if (gender && gender !== "all") pipeline.push({ $match: { gender: gender.toLowerCase() } });
    if (search?.trim()) {
      const pattern = { $regex: escapeRegex(search.trim().slice(0, 120)), $options: "i" };
      pipeline.push({ $match: { $or: ["name", "phone", "email", "mrn", "userId.name", "userId.phone", "userId.email", "organizationRelationship.contact.phone", "organizationRelationship.contact.email"].map(key => ({ [key]: pattern })) } });
    }
    const [result] = await Patient.aggregate([...pipeline, { $facet: {
      count: [{ $count: "total" }], items: [{ $sort: { createdAt: -1, _id: -1 } }, { $skip: skip }, { $limit: pageSize },
        { $project: { name: 1, phone: 1, email: 1, dob: 1, gender: 1, mrn: 1, accountType: 1, createdAt: 1, userId: 1, organizationRelationship: 1 } }],
    } }]).option({ maxTimeMS: 5000 });
    const totalCount = result?.count[0]?.total || 0;
    const patients = (result?.items || []).map((patient: any) => patientAdministrativeDTO({ ...patient,
      phone: patient.organizationRelationship?.[0]?.contact?.phone ?? patient.phone,
      email: patient.organizationRelationship?.[0]?.contact?.email ?? patient.email,
    }));
    setPaginationHeaders(reply, { totalCount, totalPages: Math.ceil(totalCount / pageSize), currentPage, pageSize });
    return reply.send(successResponse(patients));
  } catch (err) {
    req.log.error(safeError(err), "Patient directory failed");
    return reply.code(503).send(errorResponse("Patient search could not be completed. Retry before creating a new record."));
  }
}
export async function getPatientDetails(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && req.user?.role !== "patient" && req.user?.role !== "family_member") {
      return reply.code(scope.statusCode).send(errorResponse(scope.message));
    }
    let requesterOrgId = scope.allowed ? scope.organizationId : req.user?.organization_id;
    const requesterRole = req.user?.role;
    const requesterUserId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }

    const patient = await Patient.findById(id).setOptions({ bypassTenantFilter: true }).populate("userId", "name email phone");
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    // Enforce Tenant Boundaries & Role Ownership:
    // 1. Patient user can ONLY access their own patient profile
    // 2. Staff user can access patients in their active organization
    const patientUserIdStr = (patient.userId as any)?._id?.toString() || (patient.userId as any)?.id?.toString() || patient.userId?.toString() || "";
    const isSelfAccess = Boolean(patientUserIdStr && patientUserIdStr === requesterUserId);

    if (requesterRole === "patient" && !isSelfAccess) {
      return reply.code(403).send(errorResponse("Forbidden: You do not have permission to view other patients' records"));
    }

    if (requesterRole === "family_member" && !isSelfAccess && !await FamilyRelationship.exists({ userId: requesterUserId, patientId: id, status: "active" })) return reply.code(404).send(errorResponse("Patient not found"));
    if (!["patient", "family_member"].includes(requesterRole || "") && !requesterOrgId) requesterOrgId = patient.organizationId?.toString();
    if (!["patient", "family_member"].includes(requesterRole || "") && !requesterOrgId) return reply.code(403).send(errorResponse("Organization context required"));
    if (!isSelfAccess && requesterOrgId) {
      if (!await getOrganizationPatient(id, requesterOrgId)) return reply.code(404).send(errorResponse("Patient not found"));
    }
    if (!["patient", "family_member"].includes(requesterRole || "") && !await requestHasAnyPermission(req, "VIEW_EHR")) {
      const { crmPatientAuthority } = await import("../services/CrmAuthorityService.ts");
      const authority = await crmPatientAuthority(req, id);
      const { PatientRelationship } = await import("../models/PatientRelationship.ts");
      const relationship = await PatientRelationship.findOne({ patientId: id, organizationId: authority.organizationId }).lean() as any;
      const visits = await Appointment.find({ patientId: id, organizationId: authority.organizationId,
        ...(authority.locationIds ? { locationId: { $in: authority.locationIds } } : {}) }).select("_id appointmentTime appointmentType status doctorId locationId")
        .populate("doctorId", "name").populate("locationId", "name city").sort({ appointmentTime: -1, _id: -1 }).limit(50).lean();
      return reply.send(successResponse({ patient: { ...patientAdministrativeDTO({ ...patient.toObject(), phone: relationship?.contact?.phone ?? patient.phone,
        email: relationship?.contact?.email ?? patient.email }), clinicalProfileRestricted: true }, appointments: visits }));
    }
    const allRecordsRequested = (req.query as any)?.scope === "all";
    const recordAccessToken = req.headers["x-patient-record-access"] as string | undefined;
    const approved = allRecordsRequested && await hasPatientRecordAccess(recordAccessToken, id, requesterUserId, requesterOrgId || "", req.user?.sessionId);
    if (allRecordsRequested && !isSelfAccess && !approved) return reply.code(403).send(errorResponse("Patient OTP approval is required to view full history"));

    const appointmentFilter: Record<string, unknown> = { patientId: id };
    if (requesterOrgId && !approved && !isSelfAccess) {
      appointmentFilter.organizationId = requesterOrgId;
    }

    if (approved) await AuditLog.create({ userId: requesterUserId, organizationId: requesterOrgId, action: "CROSS_ORG_RECORD_READ", targetId: id, targetModel: "Patient", category: "CLINICAL_READ", details: { method: "patient_otp", resource: "patient_details" } });
    const appointments = await Appointment.find(appointmentFilter)
      .setOptions({ bypassTenantFilter: Boolean(approved || isSelfAccess) })
      .populate("doctorId", "name email")
      .populate("locationId", "name city")
      .sort({ appointmentTime: -1 })
      .limit(50);

    let patientResponse: any = patient.toJSON();
    if (!isSelfAccess && !approved && requesterOrgId && patient.organizationId && patient.organizationId.toString() !== requesterOrgId) {
      patientResponse = patientAdministrativeDTO(patient.toObject());
      patientResponse.clinicalProfileRestricted = true;
    }
    return reply.code(200).send(successResponse({
      patient: patientResponse,
      appointments
    }));
  } catch (err) {
    console.error("getPatientDetails error:", safeError(err));
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function submitDoctorReview(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const userRole = req.user!.role;
    const { id } = req.params as { id: string }; // doctor userId
    const { rating } = req.body as { rating: number; comment?: string };

    if (!rating || rating < 1 || rating > 5) {
      return reply.code(400).send(errorResponse("Rating must be between 1 and 5"));
    }

    if (userRole !== "patient" && userRole !== "family_member") {
      return reply.code(403).send(errorResponse("Forbidden: only patients can submit doctor reviews"));
    }

    let patientIds: mongoose.Types.ObjectId[] = [];
    if (userRole === "patient") {
      const selfPatient = await Patient.findOne({ userId });
      if (selfPatient) patientIds.push(selfPatient._id);
    } else {
      const rels = await FamilyRelationship.find({ userId, status: "active" });
      patientIds = rels.map((r) => r.patientId as mongoose.Types.ObjectId);
    }

    if (patientIds.length === 0) {
      return reply.code(404).send(errorResponse("Patient profile not found"));
    }

    const completedVisit = await Appointment.findOne({
      doctorId: id,
      patientId: { $in: patientIds },
      status: "completed",
    });
    if (!completedVisit) {
      return reply.code(403).send(errorResponse("Forbidden: you can only review doctors after a completed visit"));
    }

    const doctor = await Doctor.findOne({ userId: id });
    if (!doctor) {
      return reply.code(404).send(errorResponse("Doctor not found"));
    }

    // Calculate new average rating
    const currentRating = doctor.rating || 5;
    const currentReviewsCount = doctor.reviewsCount || 0;

    const newReviewsCount = currentReviewsCount + 1;
    const newRating = parseFloat(((currentRating * currentReviewsCount + rating) / newReviewsCount).toFixed(1));

    doctor.rating = newRating;
    doctor.reviewsCount = newReviewsCount;
    await doctor.save();

    return reply.code(200).send(successResponse({ rating: newRating, reviewsCount: newReviewsCount }, "Review submitted successfully"));
  } catch (err) {
    console.error("submitDoctorReview error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPatientTimelineController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const isPatientSelf = req.user?.role === "patient" || req.user?.role === "family_member";
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && !isPatientSelf) {
      return reply.code(scope.statusCode).send(errorResponse(scope.message));
    }
    let orgId: string = (scope.allowed ? scope.organizationId : req.user?.organization_id) || "";

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }

    const patientDoc = await Patient.findById(id).setOptions({ bypassTenantFilter: true }).lean() as any;
    if (!patientDoc) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    if (isPatientSelf) {
      const patientUserId = patientDoc.userId?.toString();
      if (patientUserId !== req.user?.id) {
        const { FamilyRelationship } = await import("../models/FamilyRelationship.ts");
        const hasRel = await FamilyRelationship.exists({
          userId: req.user?.id,
          patientId: id,
          status: "active",
        });
        if (!hasRel) {
          return reply.code(403).send(errorResponse("Access denied"));
        }
      }
      orgId = patientDoc.organizationId ? patientDoc.organizationId.toString() : "";
    } else {
      if (!orgId && patientDoc.organizationId) {
        orgId = patientDoc.organizationId.toString();
      }
      if (!orgId) {
        return reply.code(403).send(errorResponse("Forbidden: organization context required"));
      }
    }

    const { category, includeFinancial, q, limit, cursor } = req.query as {
      category?: string;
      includeFinancial?: string | boolean;
      q?: string;
      limit?: string | number;
      cursor?: string;
    };

    const isFinancialRequested = includeFinancial === true || includeFinancial === "true";
    const numericLimit = limit ? Number(limit) : 20;

    const includeAllRecords = !isPatientSelf && (req.query as any)?.scope === "all";
    const recordAccessToken = req.headers["x-patient-record-access"] as string | undefined;
    if (includeAllRecords && !await hasPatientRecordAccess(recordAccessToken, id, req.user?.id, orgId, req.user?.sessionId)) return reply.code(403).send(errorResponse("Patient OTP approval is required to view full history"));
    const { timelineService } = await import("../services/TimelineService.ts");
    const timelineData = await timelineService.getPatientTimeline({
      patientId: id,
      organizationId: orgId,
      userId: req.user?.id,
      includeAllRecords, recordAccessToken, sessionId: req.user?.sessionId,
      category,
      includeFinancial: isFinancialRequested,
      q,
      limit: numericLimit,
      cursor,
    });

    if (!timelineData) {
      // 404 Not Found (masks existence for multi-tenant security)
      return reply.code(404).send(errorResponse("Patient health record not found"));
    }

    return reply.code(200).send(successResponse(timelineData));
  } catch (err) {
    console.error("getPatientTimelineController error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updatePatientProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const requesterRole = req.user?.role;
    const requesterUserId = req.user?.id;
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed && requesterRole !== "patient" && requesterRole !== "family_member" && requesterRole !== "root") {
      return reply.code(scope.statusCode).send(errorResponse(scope.message));
    }
    const requesterOrgId = scope.allowed ? scope.organizationId : req.user?.organization_id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }

    const patient = await Patient.findById(id);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

    const clinicalFields = ["bloodGroup", "allergies", "conditions", "medicalNotes", "insurancePolicies", "abdmHealthId"];
    if (!["patient", "family_member"].includes(requesterRole || "") && clinicalFields.some(field => Object.prototype.hasOwnProperty.call(req.body, field)) &&
      !await requestHasAnyPermission(req, "MANAGE_EHR", "MANAGE_CLINICAL_NOTES")) return reply.code(403).send(errorResponse("Clinical profile changes require clinical permission"));

    // Tenant Boundary & Access Check
    const patientUserIdStr = (patient.userId as any)?._id?.toString() || (patient.userId as any)?.id?.toString() || patient.userId?.toString() || "";
    const isSelfAccess = Boolean(patientUserIdStr && patientUserIdStr === requesterUserId);

    if (!isSelfAccess && requesterRole !== "root") {
      if (!requesterOrgId) {
        return reply.code(403).send(errorResponse("Organization context is required"));
      }

      let isOrgMember = false;
      if (patient.organizationId && patient.organizationId.toString() === requesterOrgId) {
        isOrgMember = true;
      } else if (patient.userId) {
        const member = await OrgMember.findOne({ userId: patient.userId, organizationId: requesterOrgId });
        if (member) isOrgMember = true;
      }

      if (!isOrgMember) {
        return reply.code(404).send(errorResponse("Patient not found"));
      }
    }

    if (!patient.organizationId && requesterOrgId) {
      patient.organizationId = requesterOrgId as any;
    }

    const {
      name,
      phone,
      dob,
      gender,
      bloodGroup,
      address,
      city,
      state,
      pincode,
      nationality,
      allergies,
      conditions,
      medicalNotes,
      emergencyContacts,
      insurancePolicies,
      abdmHealthId,
    } = req.body as any;

    if (gender !== undefined && !["male", "female", "other"].includes(gender.toLowerCase())) {
      return reply.code(400).send(errorResponse("Invalid gender. Allowed values: male, female, other"));
    }

    if (bloodGroup !== undefined && bloodGroup !== "" && !["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"].includes(bloodGroup)) {
      return reply.code(400).send(errorResponse("Invalid blood group. Allowed values: A+, A-, B+, B-, O+, O-, AB+, AB-"));
    }

    if (dob !== undefined && dob !== "") {
      const parsedDob = new Date(dob);
      if (isNaN(parsedDob.getTime())) {
        return reply.code(400).send(errorResponse("Invalid date of birth format"));
      }
      if (parsedDob > new Date()) {
        return reply.code(400).send(errorResponse("Date of birth cannot be in the future"));
      }
      patient.dob = parsedDob;
    } else if (dob === "") {
      patient.dob = undefined;
    }

    // Organization staff correct their contact through PatientRelationship. This
    // endpoint must not silently change a global login account or another tenant.
    if (phone !== undefined && String(phone).trim() !== String(patient.phone || "").trim()) {
      return reply.code(400).send(errorResponse("Use organization contact correction for contact changes. Login contacts require account verification."));
    }
    if (name && !isSelfAccess && patient.userId) {
      const currentIdentity = await User.findById(patient.userId).select("name");
      if (name.trim() !== (patient.name || currentIdentity?.name || "").trim()) return reply.code(409).send(errorResponse("A linked patient name change requires identity review"));
    }
    if (name && !patient.userId) patient.name = name.trim();
    if (name && isSelfAccess) {
      const user = await User.findById(patient.userId);
      if (user) {
        user.name = name.trim();
        patient.name = name.trim();
        await user.save();
      }
    }

    if (gender !== undefined) patient.gender = gender.toLowerCase();
    if (bloodGroup !== undefined) patient.bloodGroup = bloodGroup;
    if (address !== undefined) patient.address = address;
    if (city !== undefined) (patient as any).city = city;
    if (state !== undefined) (patient as any).state = state;
    if (pincode !== undefined) (patient as any).pincode = pincode;
    if (nationality !== undefined) (patient as any).nationality = nationality;
    if (allergies !== undefined) patient.allergies = allergies;
    if (conditions !== undefined) patient.conditions = conditions;
    if (medicalNotes !== undefined) patient.medicalNotes = medicalNotes;
    if (emergencyContacts !== undefined) patient.emergencyContacts = emergencyContacts;
    if (insurancePolicies !== undefined) patient.insurancePolicies = insurancePolicies;
    if (abdmHealthId !== undefined) patient.abdmHealthId = abdmHealthId;

    await patient.save();

    const updatedPatient = await Patient.findById(id).populate("userId", "name email phone");
    if (!["patient", "family_member"].includes(requesterRole || "") && !await requestHasAnyPermission(req, "VIEW_EHR")) return reply.send(successResponse(patientAdministrativeDTO(updatedPatient?.toObject()), "Patient demographics saved"));
    return reply.code(200).send(successResponse(updatedPatient, "Patient profile updated successfully"));
  } catch (err) {
    console.error("updatePatientProfile error:", safeError(err));
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function createPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    if (["patient", "family_member", "guest"].includes(req.user?.role || "")) return reply.code(403).send(errorResponse("Staff registration permission required"));
    const scope = resolveAuthorizedOrganizationScope(req);
    if (!scope.allowed) return reply.code(scope.statusCode).send(errorResponse(scope.message));
    if (!scope.organizationId) return reply.code(400).send(errorResponse("Organization context required"));
    const { registerOrganizationPatient } = await import("../services/PatientRegistrationService.ts");
    const { checkLocationAccess } = await import("../utilities/tenant.ts");
    const input = { ...(req.body as any) };
    if (input.locationId) {
      const branch = await checkLocationAccess(req, input.locationId, { requireExplicitScope: true });
      if (!branch.allowed) return reply.code(branch.statusCode).send(errorResponse(branch.message));
    }
    // Older clients remain accepted; current clients retain this identifier across
    // timeouts. Matching still requires review on a repeated legacy submission.
    const requestId = String(req.headers["idempotency-key"] || input?.clientRequestId || crypto.randomUUID());
    const result = await registerOrganizationPatient(scope.organizationId, req.user!.id, input, requestId);
    return reply.code(result.replayed ? 200 : 201).send(successResponse(result.patient, result.replayed ? "Existing registration restored" : "Patient registered successfully"));
  } catch (err: any) {
    const { CommandError } = await import("../services/CommandReceiptService.ts");
    if (err instanceof CommandError) return reply.code(err.statusCode).send(errorResponse(err.message, err.details));
    if (err?.name === "ValidationError") return reply.code(400).send(errorResponse("Invalid patient registration details"));
    req.log.error(safeError(err), "Patient registration failed");
    return reply.code(503).send(errorResponse("Registration could not be confirmed. Retry with the same request identifier."));
  }
}

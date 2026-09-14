import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { FamilyRelationship } from "../models/FamilyRelationship.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function searchPatients(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const userRole = req.user?.role;
    const { search, gender, page, limit } = req.query as {
      search?: string;
      gender?: string;
      page?: string | number;
      limit?: string | number;
    };

    // Patient directory search is a staff workflow — block portal users from listing records.
    if (userRole === "patient" || userRole === "family_member") {
      return reply.code(403).send(errorResponse("Forbidden: staff access required"));
    }

    const patientFilter: Record<string, unknown> = {};
    const andConditions: Record<string, unknown>[] = [];

    if (userRole !== "root") {
      if (!orgId) {
        return reply.code(403).send(errorResponse("Organization context is required"));
      }
      andConditions.push({
        $or: [
          { organizationId: orgId },
          { createdBy: new mongoose.Types.ObjectId(req.user!.id) },
        ],
      });
    }

    if (gender && gender.toLowerCase() !== "all") {
      patientFilter.gender = gender.toLowerCase();
    }

    if (search && search.trim()) {
      const safeSearch = escapeRegex(search.trim());

      const matchingUsers = await User.find({
        role: "patient",
        isActive: true,
        $or: [
          { name: { $regex: safeSearch, $options: "i" } },
          { email: { $regex: safeSearch, $options: "i" } },
          { phone: { $regex: safeSearch, $options: "i" } },
        ],
      }).select("_id");
      const matchingUserIds = matchingUsers.map((u) => u._id);

      // Compose search criteria without replacing the tenant scope filter above.
      andConditions.push({
        $or: [
          { name: { $regex: safeSearch, $options: "i" } },
          { phone: { $regex: safeSearch, $options: "i" } },
          { email: { $regex: safeSearch, $options: "i" } },
          { userId: { $in: matchingUserIds } },
          { mrn: { $regex: safeSearch, $options: "i" } },
          { abdmHealthId: { $regex: safeSearch, $options: "i" } },
          { allergies: { $regex: safeSearch, $options: "i" } },
          { conditions: { $regex: safeSearch, $options: "i" } },
        ],
      });
    }

    if (andConditions.length > 0) {
      patientFilter.$and = andConditions;
    }

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });

    const [totalCount, rawPatients] = await Promise.all([
      Patient.countDocuments(patientFilter),
      Patient.find(patientFilter)
        .populate("userId", "name email phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean(),
    ]);

    const totalPages = Math.ceil(totalCount / pageSize);
    const patients = rawPatients.map((p: any) => ({ ...p, id: p._id.toString() }));

    setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
    return reply.code(200).send(successResponse(patients));
  } catch (err) {
    console.error("searchPatients error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPatientDetails(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const requesterOrgId = req.user?.organization_id;
    const requesterRole = req.user?.role;
    const requesterUserId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }
    
    const patient = await Patient.findById(id).populate("userId", "name email phone");
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

    if (!isSelfAccess && requesterOrgId) {
      let isOrgMember = false;
      if (patient.organizationId && patient.organizationId.toString() === requesterOrgId) {
        isOrgMember = true;
      } else if (patient.userId) {
        const targetUserObjId = (patient.userId as any)._id || patient.userId;
        const member = await OrgMember.findOne({ userId: targetUserObjId, organizationId: requesterOrgId });
        if (member) isOrgMember = true;
      }

      if (!isOrgMember) {
        // Return 404 to prevent cross-tenant resource enumeration
        return reply.code(404).send(errorResponse("Patient not found"));
      }
    }

    const appointmentFilter: Record<string, unknown> = { patientId: id };
    if (requesterOrgId && requesterRole !== "root") {
      appointmentFilter.organizationId = requesterOrgId;
    }

    const appointments = await Appointment.find(appointmentFilter)
      .populate("doctorId", "name email")
      .populate("clinicId", "name city")
      .sort({ appointmentTime: -1 })
      .limit(50);

    return reply.code(200).send(successResponse({
      patient,
      appointments
    }));
  } catch (err) {
    console.error("getPatientDetails error:", err);
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
    console.error("submitDoctorReview error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getPatientTimelineController(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    let orgId: string = req.user?.organization_id || "";

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }

    const isPatientSelf = req.user?.role === "patient" || req.user?.role === "family_member";

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

    const { timelineService } = await import("../services/TimelineService.ts");
    const timelineData = await timelineService.getPatientTimeline({
      patientId: id,
      organizationId: orgId,
      userId: req.user?.id,
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
    console.error("getPatientTimelineController error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function updatePatientProfile(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { id } = req.params as { id: string };
    const requesterOrgId = req.user?.organization_id;
    const requesterRole = req.user?.role;
    const requesterUserId = req.user?.id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }

    const patient = await Patient.findById(id);
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
    }

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

    if (name || phone) {
      const user = await User.findById(patient.userId);
      if (user) {
        if (name) user.name = name;
        if (phone) user.phone = phone;
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
    return reply.code(200).send(successResponse(updatedPatient, "Patient profile updated successfully"));
  } catch (err) {
    console.error("updatePatientProfile error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function createPatient(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const userId = req.user!.id;
    if (!orgId) return reply.code(400).send(errorResponse("Organization context required"));

    const {
      name, email, phone, dob, gender, bloodGroup,
      address, city, state, pincode, nationality,
      allergies, conditions, medicalNotes, emergencyContacts, ignoreDuplicate
    } = req.body as any;

    if (!name || (!phone && !email)) {
      return reply.code(400).send(errorResponse("Patient name and either phone or email are required"));
    }

    // Check for duplicate patient matches before creating
    if (!ignoreDuplicate) {
      const { patientMatchingService } = await import("../services/PatientMatchingService.ts");
      const matches = await patientMatchingService.findMatchingPatients({
        name,
        phone,
        email,
        dob,
        organizationId: orgId,
      });

      if (matches.highConfidence.length > 0 || matches.mediumConfidence.length > 0) {
        return reply.code(409).send(
          errorResponse("Possible existing matching patient record found.", {
            highConfidenceMatches: matches.highConfidence,
            mediumConfidenceMatches: matches.mediumConfidence,
          })
        );
      }
    }

    // Create Walk-in Patient record without fake User account
    const patientProfile = await Patient.create({
      name: name.trim(),
      phone: phone?.trim() || null,
      email: email?.trim().toLowerCase() || null,
      accountType: "walkin",
      createdBy: userId,
      organizationId: orgId,
      personalVaultId: `pvt_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`,
      dob: dob ? new Date(dob) : undefined,
      gender,
      bloodGroup,
      address: address || null,
      city: city || null,
      state: state || null,
      pincode: pincode || null,
      nationality: nationality || "Indian",
      allergies: allergies || [],
      conditions: conditions || [],
      medicalNotes: medicalNotes || null,
      emergencyContacts: emergencyContacts || [],
    });

    const fullPatient = await Patient.findById(patientProfile._id).populate("userId", "name email phone");
    return reply.code(201).send(successResponse(fullPatient, "Patient registered successfully"));
  } catch (err: any) {
    console.error("createPatient error:", err);
    return reply.code(500).send(errorResponse(err.message || "Internal server error"));
  }
}


import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function searchPatients(req: FastifyRequest, reply: FastifyReply) {
  try {
    const orgId = req.user?.organization_id;
    const userRole = req.user?.role;
    const { search, page, limit } = req.query as { search?: string; page?: string | number; limit?: string | number };
    
    let allowedUserIds: mongoose.Types.ObjectId[] | null = null;
    if (userRole !== "patient" && orgId) {
      // Find all userIds linked to this organization via OrgMember or Patient.organizationId
      const orgMembers = await OrgMember.find({ organizationId: orgId, role: "patient" }).select("userId");
      const orgMemberUserIds = orgMembers.map(m => m.userId);

      const orgPatients = await Patient.find({ organizationId: orgId }).select("userId");
      const orgPatientUserIds = orgPatients.map(p => p.userId);

      const mergedSet = new Set([
        ...orgMemberUserIds.map(id => id.toString()),
        ...orgPatientUserIds.map(id => id.toString())
      ]);
      allowedUserIds = Array.from(mergedSet).map(id => new mongoose.Types.ObjectId(id));
    }

    const userQuery: any = { role: "patient", isActive: true };
    if (allowedUserIds) {
      userQuery._id = { $in: allowedUserIds };
    }

    if (search) {
      const safeSearch = escapeRegex(search);
      userQuery.$or = [
        { name: { $regex: safeSearch, $options: "i" } },
        { email: { $regex: safeSearch, $options: "i" } },
        { phone: { $regex: safeSearch, $options: "i" } }
      ];
    }
    
    const totalCount = await User.countDocuments(userQuery);
    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalPages = Math.ceil(totalCount / pageSize);

    const users = await User.find(userQuery).skip(skip).limit(pageSize);

    if (users.length === 0) {
      setPaginationHeaders(reply, { totalCount, totalPages, currentPage, pageSize });
      return reply.code(200).send(successResponse([]));
    }

    const userIds = users.map(u => u._id);
    const patients = await Patient.find({ userId: { $in: userIds } }).populate("userId", "name email phone");

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

    // Enforce Tenant Boundaries:
    // 1. Patient user can access their own patient profile
    // 2. Staff user can access patients in their active organization
    const patientUserIdStr = (patient.userId as any)?._id?.toString() || (patient.userId as any)?.id?.toString() || patient.userId.toString();
    const isSelfAccess = patientUserIdStr === requesterUserId;

    if (!isSelfAccess && requesterOrgId) {
      let isOrgMember = false;
      if (patient.organizationId && patient.organizationId.toString() === requesterOrgId) {
        isOrgMember = true;
      } else {
        const member = await OrgMember.findOne({ userId: patient.userId._id || patient.userId, organizationId: requesterOrgId });
        if (member) isOrgMember = true;
      }

      if (!isOrgMember) {
        // Return 404 to prevent cross-tenant resource enumeration
        return reply.code(404).send(errorResponse("Patient not found"));
      }
    }

    const appointments = await Appointment.find({ patientId: id })
      .populate("doctorId", "name email")
      .populate("clinicId", "name city")
      .sort({ appointmentTime: -1 });

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
    const { id } = req.params as { id: string }; // doctor userId
    const { rating } = req.body as { rating: number; comment?: string };

    if (!rating || rating < 1 || rating > 5) {
      return reply.code(400).send(errorResponse("Rating must be between 1 and 5"));
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
    let orgId = req.user?.organization_id;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return reply.code(400).send(errorResponse("Invalid patient ID"));
    }

    if (!orgId) {
      const patientDoc = await Patient.findById(id).lean();
      if (patientDoc?.organizationId) {
        orgId = patientDoc.organizationId.toString();
      }
    }

    if (!orgId) {
      return reply.code(403).send(errorResponse("Forbidden: organization context required"));
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


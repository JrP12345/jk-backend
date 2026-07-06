import type { FastifyRequest, FastifyReply } from "fastify";
import { User } from "../models/User.ts";
import { Patient } from "../models/Patient.ts";
import { Appointment } from "../models/Appointment.ts";
import { Doctor } from "../models/Doctor.ts";
import { successResponse, errorResponse, escapeRegex, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";

export async function searchPatients(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { search, page, limit } = req.query as { search?: string; page?: string | number; limit?: string | number };
    
    const userQuery: any = { role: "patient", isActive: true };
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
    
    const patient = await Patient.findById(id).populate("userId", "name email phone");
    if (!patient) {
      return reply.code(404).send(errorResponse("Patient not found"));
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


import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse, getPaginationParams, setPaginationHeaders } from "../utilities/helpers.ts";
import { checkClinicAccess, getRequestClinicIds } from "../utilities/tenant.ts";

export async function submitFeedback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const userId = req.user!.id;
    const { appointmentId, rating, npsScore, comments, aspectRatings } = req.body as {
      appointmentId: string;
      rating: number;
      npsScore: number;
      comments?: string;
      aspectRatings?: { waitTime?: number; doctorAttitude?: number; cleanliness?: number };
    };

    if (!appointmentId || rating === undefined || npsScore === undefined) {
      return reply.code(400).send(errorResponse("appointmentId, rating (1-5), and npsScore (0-10) are required"));
    }

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return reply.code(400).send(errorResponse("Invalid appointment ID"));
    }
    if (!Number.isFinite(Number(rating)) || Number(rating) < 1 || Number(rating) > 5) {
      return reply.code(400).send(errorResponse("Rating must be between 1 and 5"));
    }
    if (!Number.isFinite(Number(npsScore)) || Number(npsScore) < 0 || Number(npsScore) > 10) {
      return reply.code(400).send(errorResponse("NPS score must be between 0 and 10"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    const clinicAccess = await checkClinicAccess(req, appointment.clinicId);
    if (!clinicAccess.allowed) {
      return reply.code(404).send(errorResponse("Appointment not found"));
    }

    if (req.user?.role === "patient") {
      const patient = await (await import("../models/Patient.ts")).Patient.findOne({ userId: req.user.id });
      if (!patient || patient._id.toString() !== appointment.patientId.toString()) {
        return reply.code(403).send(errorResponse("Feedback can only be submitted for your own appointment"));
      }
    }

    const existing = await PatientFeedback.findOne({ appointmentId });
    if (existing) {
      return reply.code(400).send(errorResponse("Feedback already submitted for this appointment"));
    }

    const feedback = await PatientFeedback.create({
      appointmentId,
      patientId: appointment.patientId,
      doctorId: appointment.doctorId,
      clinicId: appointment.clinicId,
      rating: Number(rating),
      npsScore: Number(npsScore),
      comments: comments?.trim(),
      aspectRatings,
    });

    await AuditLog.create({
      userId,
      action: "PATIENT_FEEDBACK_SUBMIT",
      targetId: feedback._id,
      targetModel: "PatientFeedback",
      details: { rating, npsScore }
    });

    return reply.code(201).send(successResponse(feedback, "Thank you! Your feedback has been recorded successfully."));
  } catch (err) {
    console.error("submitFeedback error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFeedbackStats(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId } = req.query as { clinicId?: string; doctorId?: string };

    const filter: any = {};
    if (clinicId) {
      if (!(await checkClinicAccess(req, clinicId)).allowed) {
        return reply.code(404).send(errorResponse("Clinic not found"));
      }
      filter.clinicId = clinicId;
    } else if (req.user?.role !== "root") {
      filter.clinicId = { $in: await getRequestClinicIds(req) };
    }
    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) filter.doctorId = doctorId;

    const feedbacks = await PatientFeedback.find(filter);

    let totalRating = 0;
    let promoters = 0;
    let detractors = 0;
    const aspectTotals = { waitTime: 0, doctorAttitude: 0, cleanliness: 0 };
    const aspectCounts = { waitTime: 0, doctorAttitude: 0, cleanliness: 0 };

    feedbacks.forEach((f) => {
      totalRating += f.rating;
      if (f.npsScore >= 9) promoters++;
      else if (f.npsScore <= 6) detractors++;
      for (const key of Object.keys(aspectTotals) as Array<keyof typeof aspectTotals>) {
        const value = f.aspectRatings?.[key];
        if (typeof value === "number") {
          aspectTotals[key] += value;
          aspectCounts[key]++;
        }
      }
    });

    const totalCount = feedbacks.length;
    const avgRating = totalCount > 0 ? Number((totalRating / totalCount).toFixed(2)) : 0;
    const nps = totalCount > 0 ? Math.round(((promoters - detractors) / totalCount) * 100) : 0;

    return reply.code(200).send(
      successResponse({
        totalResponses: totalCount,
        averageCsatRating: avgRating,
        netPromoterScore: nps,
        npsCategory: totalCount === 0 ? "No responses" : nps >= 50 ? "Excellent" : nps >= 0 ? "Good" : "Needs Improvement",
        averageAspectRatings: {
          waitTime: aspectCounts.waitTime ? Number((aspectTotals.waitTime / aspectCounts.waitTime).toFixed(2)) : null,
          doctorAttitude: aspectCounts.doctorAttitude ? Number((aspectTotals.doctorAttitude / aspectCounts.doctorAttitude).toFixed(2)) : null,
          cleanliness: aspectCounts.cleanliness ? Number((aspectTotals.cleanliness / aspectCounts.cleanliness).toFixed(2)) : null,
        },
      })
    );
  } catch (err) {
    console.error("getFeedbackStats error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

export async function getFeedback(req: FastifyRequest, reply: FastifyReply) {
  try {
    const { clinicId, doctorId, page, limit } = req.query as {
      clinicId?: string;
      doctorId?: string;
      page?: string | number;
      limit?: string | number;
    };
    const filter: any = {};

    if (clinicId) {
      if (!(await checkClinicAccess(req, clinicId)).allowed) {
        return reply.code(404).send(errorResponse("Clinic not found"));
      }
      filter.clinicId = clinicId;
    } else if (req.user?.role !== "root") {
      filter.clinicId = { $in: await getRequestClinicIds(req) };
    }
    if (doctorId) {
      if (!mongoose.Types.ObjectId.isValid(doctorId)) {
        return reply.code(400).send(errorResponse("Invalid doctor ID"));
      }
      filter.doctorId = doctorId;
    }

    const { page: currentPage, limit: pageSize, skip } = getPaginationParams({ page, limit });
    const totalCount = await PatientFeedback.countDocuments(filter);
    const feedback = await PatientFeedback.find(filter)
      .populate("clinicId", "name city")
      .populate("doctorId", "name specialization")
      .populate("patientId", "userId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(pageSize);

    setPaginationHeaders(reply, {
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      currentPage,
      pageSize,
    });
    return reply.code(200).send(successResponse(feedback));
  } catch (err) {
    console.error("getFeedback error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

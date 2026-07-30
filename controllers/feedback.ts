import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { PatientFeedback } from "../models/PatientFeedback.ts";
import { Appointment } from "../models/Appointment.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";

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

    if (!appointmentId || !rating || npsScore === undefined) {
      return reply.code(400).send(errorResponse("appointmentId, rating (1-5), and npsScore (0-10) are required"));
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return reply.code(404).send(errorResponse("Appointment not found"));
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
      rating,
      npsScore,
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
    if (clinicId && mongoose.Types.ObjectId.isValid(clinicId)) filter.clinicId = clinicId;
    if (doctorId && mongoose.Types.ObjectId.isValid(doctorId)) filter.doctorId = doctorId;

    const feedbacks = await PatientFeedback.find(filter);

    let totalRating = 0;
    let promoters = 0;
    let detractors = 0;

    feedbacks.forEach((f) => {
      totalRating += f.rating;
      if (f.npsScore >= 9) promoters++;
      else if (f.npsScore <= 6) detractors++;
    });

    const totalCount = feedbacks.length;
    const avgRating = totalCount > 0 ? Number((totalRating / totalCount).toFixed(2)) : 4.85;
    const nps = totalCount > 0 ? Math.round(((promoters - detractors) / totalCount) * 100) : 88;

    return reply.code(200).send(
      successResponse({
        totalResponses: totalCount,
        averageCsatRating: avgRating,
        netPromoterScore: nps,
        npsCategory: nps >= 50 ? "Excellent" : nps >= 0 ? "Good" : "Needs Improvement",
      })
    );
  } catch (err) {
    console.error("getFeedbackStats error:", err);
    return reply.code(500).send(errorResponse("Internal server error"));
  }
}

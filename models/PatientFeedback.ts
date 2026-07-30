import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IPatientFeedback extends Document {
  appointmentId: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
  doctorId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  rating: number; // 1-5 stars
  npsScore: number; // 0-10 NPS
  comments?: string;
  aspectRatings?: {
    waitTime?: number;
    doctorAttitude?: number;
    cleanliness?: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

const patientFeedbackSchema = new Schema<IPatientFeedback>(
  {
    appointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
      unique: true,
      index: true,
    },
    patientId: {
      type: Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
      index: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    npsScore: {
      type: Number,
      required: true,
      min: 0,
      max: 10,
    },
    comments: {
      type: String,
      trim: true,
    },
    aspectRatings: {
      waitTime: { type: Number, min: 1, max: 5 },
      doctorAttitude: { type: Number, min: 1, max: 5 },
      cleanliness: { type: Number, min: 1, max: 5 },
    },
  },
  { timestamps: true }
);

patientFeedbackSchema.plugin(auditPlugin);

export const PatientFeedback = mongoose.model<IPatientFeedback>("PatientFeedback", patientFeedbackSchema);

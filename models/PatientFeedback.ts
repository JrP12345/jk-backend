import mongoose, { Schema, Document } from "mongoose";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";

export interface IPatientFeedback extends Document {
  organizationId?: mongoose.Types.ObjectId;
  source?: 'patient_submitted' | 'staff_reported';
  submittedBy?: mongoose.Types.ObjectId;
  appointmentId: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
  doctorId: mongoose.Types.ObjectId;
  locationId: mongoose.Types.ObjectId;
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
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
    source: { type: String, enum: ['patient_submitted', 'staff_reported'] },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
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
    locationId: {
      type: Schema.Types.ObjectId,
      ref: "Location",
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
      set: encryptField, get: decryptField, select: false,
      validate: { validator: (value: string) => !value || decryptField(value).length <= 2000, message: 'Comments must be at most 2000 characters' },
    },
    aspectRatings: {
      waitTime: { type: Number, min: 1, max: 5 },
      doctorAttitude: { type: Number, min: 1, max: 5 },
      cleanliness: { type: Number, min: 1, max: 5 },
    },
  },
  { timestamps: true }
);

// The submission command writes a minimal audit in the same transaction. Free
// text must never be duplicated by the generic document audit plugin.
patientFeedbackSchema.index({ organizationId: 1, locationId: 1, createdAt: -1, _id: -1 });

export const PatientFeedback = mongoose.model<IPatientFeedback>("PatientFeedback", patientFeedbackSchema);

import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface ITeleconsultationSession extends Document {
  sessionRoomId: string;
  appointmentId: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
  doctorId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  meetingUrl: string;
  status: "scheduled" | "active" | "ended" | "missed";
  startedAt?: Date;
  endedAt?: Date;
  durationMinutes?: number;
  createdAt: Date;
  updatedAt: Date;
}

const teleconsultationSessionSchema = new Schema<ITeleconsultationSession>(
  {
    sessionRoomId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    appointmentId: {
      type: Schema.Types.ObjectId,
      ref: "Appointment",
      required: true,
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
    meetingUrl: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["scheduled", "active", "ended", "missed"],
      default: "scheduled",
      index: true,
    },
    startedAt: { type: Date },
    endedAt: { type: Date },
    durationMinutes: { type: Number, default: 0 },
  },
  { timestamps: true }
);

teleconsultationSessionSchema.plugin(auditPlugin);

export const TeleconsultationSession = mongoose.model<ITeleconsultationSession>("TeleconsultationSession", teleconsultationSessionSchema);

import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface ISurgicalBooking extends Document {
  patientId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  theatreName: string;
  procedureName: string;
  leadSurgeonId: mongoose.Types.ObjectId;
  anesthesiologistId?: mongoose.Types.ObjectId;
  scrubNurseName?: string;
  scheduledStartTime: Date;
  scheduledEndTime: Date;
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  safetyChecklistComplete: boolean;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const surgicalBookingSchema = new Schema<ISurgicalBooking>(
  {
    patientId: {
      type: Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
      index: true,
    },
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },
    theatreName: {
      type: String,
      required: true,
      trim: true,
    },
    procedureName: {
      type: String,
      required: true,
      trim: true,
    },
    leadSurgeonId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    anesthesiologistId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    scrubNurseName: {
      type: String,
      trim: true,
    },
    scheduledStartTime: {
      type: Date,
      required: true,
      index: true,
    },
    scheduledEndTime: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed", "cancelled"],
      default: "scheduled",
      index: true,
    },
    safetyChecklistComplete: {
      type: Boolean,
      default: false,
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

surgicalBookingSchema.plugin(auditPlugin);

export const SurgicalBooking = mongoose.model<ISurgicalBooking>("SurgicalBooking", surgicalBookingSchema);

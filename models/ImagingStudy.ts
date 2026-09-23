import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IImagingStudy extends Document {
  studyInstanceUid: string;
  patientId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  modality: "CR" | "DX" | "CT" | "MR" | "US" | "MG";
  studyDescription: string;
  radiologistId?: mongoose.Types.ObjectId;
  dicomWebUrl?: string;
  radiologyReport?: string;
  status: "requested" | "in_progress" | "completed" | "reported" | "cancelled";
  createdAt: Date;
  updatedAt: Date;
}

const imagingStudySchema = new Schema<IImagingStudy>(
  {
    studyInstanceUid: {
      type: String,
      required: true,
      unique: true,
    },
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
    },
    modality: {
      type: String,
      enum: ["CR", "DX", "CT", "MR", "US", "MG"],
      required: true,
      index: true,
    },
    studyDescription: {
      type: String,
      required: true,
      trim: true,
    },
    radiologistId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    dicomWebUrl: {
      type: String,
      trim: true,
    },
    radiologyReport: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["requested", "in_progress", "completed", "reported", "cancelled"],
      default: "requested",
      index: true,
    },
  },
  { timestamps: true }
);

imagingStudySchema.plugin(auditPlugin);

imagingStudySchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });

export const ImagingStudy = mongoose.model<IImagingStudy>("ImagingStudy", imagingStudySchema);

import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IFacilityTransfer extends Document {
  transferNumber: string;
  patientId: mongoose.Types.ObjectId;
  sourceClinicId: mongoose.Types.ObjectId;
  targetClinicId: mongoose.Types.ObjectId;
  reasonForTransfer: string;
  priority: "routine" | "urgent" | "emergency";
  ambulanceDispatched: boolean;
  ambulanceVehicleNumber?: string;
  status: "requested" | "accepted" | "in_transit" | "completed" | "rejected";
  transferNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const facilityTransferSchema = new Schema<IFacilityTransfer>(
  {
    transferNumber: {
      type: String,
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
    sourceClinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },
    targetClinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },
    reasonForTransfer: {
      type: String,
      required: true,
      trim: true,
    },
    priority: {
      type: String,
      enum: ["routine", "urgent", "emergency"],
      default: "routine",
      index: true,
    },
    ambulanceDispatched: {
      type: Boolean,
      default: false,
    },
    ambulanceVehicleNumber: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["requested", "accepted", "in_transit", "completed", "rejected"],
      default: "requested",
      index: true,
    },
    transferNotes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

facilityTransferSchema.plugin(auditPlugin);

export const FacilityTransfer = mongoose.model<IFacilityTransfer>("FacilityTransfer", facilityTransferSchema);

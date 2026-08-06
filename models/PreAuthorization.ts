import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IPreAuthorization extends Document {
  preAuthNumber: string;
  patientId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  doctorId: mongoose.Types.ObjectId;
  claimId?: mongoose.Types.ObjectId;
  tpaName: string;
  policyNumber: string;
  diagnosisCode: string;
  proposedTreatment: string;
  requestedAmount: number;
  approvedAmount: number;
  status: "draft" | "submitted" | "under_query" | "approved" | "rejected" | "cancelled";
  queryNotes?: string;
  denialReason?: string;
  approvalCode?: string;
  validUntil?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const preAuthorizationSchema = new Schema<IPreAuthorization>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    preAuthNumber: {
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
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    claimId: {
      type: Schema.Types.ObjectId,
      ref: "Claim",
      index: true,
    },
    tpaName: {
      type: String,
      required: true,
      trim: true,
    },
    policyNumber: {
      type: String,
      required: true,
      trim: true,
    },
    diagnosisCode: {
      type: String,
      required: true,
      trim: true,
    },
    proposedTreatment: {
      type: String,
      required: true,
      trim: true,
    },
    requestedAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    approvedAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["draft", "submitted", "under_query", "approved", "rejected", "cancelled"],
      default: "draft",
      index: true,
    },
    queryNotes: {
      type: String,
      trim: true,
    },
    denialReason: {
      type: String,
      trim: true,
    },
    approvalCode: {
      type: String,
      trim: true,
    },
    validUntil: {
      type: Date,
    },
  },
  { timestamps: true }
);

preAuthorizationSchema.plugin(auditPlugin);

export const PreAuthorization = mongoose.model<IPreAuthorization>("PreAuthorization", preAuthorizationSchema);

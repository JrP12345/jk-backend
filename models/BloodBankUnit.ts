import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IBloodBankUnit extends Document {
  unitNumber: string;
  clinicId: mongoose.Types.ObjectId;
  bloodGroup: "A+" | "A-" | "B+" | "B-" | "AB+" | "AB-" | "O+" | "O-";
  componentType: "whole_blood" | "prbc" | "ffp" | "platelets";
  volumeMl: number;
  expiryDate: Date;
  status: "available" | "reserved" | "transfused" | "expired" | "discarded";
  reservedForPatientId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const bloodBankUnitSchema = new Schema<IBloodBankUnit>(
  {
    unitNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },
    bloodGroup: {
      type: String,
      enum: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
      required: true,
      index: true,
    },
    componentType: {
      type: String,
      enum: ["whole_blood", "prbc", "ffp", "platelets"],
      default: "prbc",
      index: true,
    },
    volumeMl: {
      type: Number,
      required: true,
      min: 50,
    },
    expiryDate: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["available", "reserved", "transfused", "expired", "discarded"],
      default: "available",
      index: true,
    },
    reservedForPatientId: {
      type: Schema.Types.ObjectId,
      ref: "Patient",
    },
  },
  { timestamps: true }
);

bloodBankUnitSchema.plugin(auditPlugin);

export const BloodBankUnit = mongoose.model<IBloodBankUnit>("BloodBankUnit", bloodBankUnitSchema);

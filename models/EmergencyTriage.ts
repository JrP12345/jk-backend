import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IEmergencyTriage extends Document {
  patientId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  esiLevel: 1 | 2 | 3 | 4 | 5; // 1: Resuscitation, 2: Emergent, 3: Urgent, 4: Less Urgent, 5: Non-Urgent
  chiefComplaint: string;
  triageCategory: "trauma" | "cardiac" | "respiratory" | "stroke" | "pediatric" | "general";
  vitals: {
    heartRate?: number;
    bpSys?: number;
    bpDia?: number;
    respRate?: number;
    spo2?: number;
    temperature?: number;
    gcsScore?: number; // Glasgow Coma Scale (3-15)
  };
  assignedBay?: string; // e.g. "Trauma Bay 1", "Resus Room 2", "ED Bed 4"
  attendingDoctorId?: mongoose.Types.ObjectId;
  notes?: string;
  status: "triaged" | "under_treatment" | "admitted" | "discharged" | "transferred";
  createdAt: Date;
  updatedAt: Date;
}

const emergencyTriageSchema = new Schema<IEmergencyTriage>(
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
    esiLevel: {
      type: Number,
      enum: [1, 2, 3, 4, 5],
      required: true,
      index: true,
    },
    chiefComplaint: {
      type: String,
      required: true,
      trim: true,
    },
    triageCategory: {
      type: String,
      enum: ["trauma", "cardiac", "respiratory", "stroke", "pediatric", "general"],
      default: "general",
      index: true,
    },
    vitals: {
      heartRate: Number,
      bpSys: Number,
      bpDia: Number,
      respRate: Number,
      spo2: Number,
      temperature: Number,
      gcsScore: { type: Number, min: 3, max: 15 },
    },
    assignedBay: {
      type: String,
      trim: true,
    },
    attendingDoctorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    notes: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["triaged", "under_treatment", "admitted", "discharged", "transferred"],
      default: "triaged",
      index: true,
    },
  },
  { timestamps: true }
);

emergencyTriageSchema.plugin(auditPlugin);

export const EmergencyTriage = mongoose.model<IEmergencyTriage>("EmergencyTriage", emergencyTriageSchema);

import mongoose, { Schema } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IScheduleH1Register {
  organizationId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  medicineId: mongoose.Types.ObjectId;
  medicineName: string;
  genericName?: string;
  scheduleType: "schedule_h" | "schedule_h1" | "schedule_x" | "narcotic";
  batchNumber: string;
  expiryDate?: Date;
  quantityDispensed: number;
  patientId: mongoose.Types.ObjectId;
  patientName: string;
  patientAddress?: string;
  patientPhone?: string;
  doctorId?: mongoose.Types.ObjectId;
  doctorName?: string;
  doctorRegNumber?: string;
  prescriptionId?: mongoose.Types.ObjectId;
  encounterId?: mongoose.Types.ObjectId;
  invoiceId?: mongoose.Types.ObjectId;
  dispensedBy?: mongoose.Types.ObjectId;
  dispensedByName?: string;
  dispensedAt: Date;
  createdAt: Date;
}

const ScheduleH1RegisterSchema = new Schema<IScheduleH1Register>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    medicineId: { type: Schema.Types.ObjectId, ref: "Medicine", required: true, index: true },
    medicineName: { type: String, required: true, trim: true },
    genericName: { type: String, trim: true },
    scheduleType: {
      type: String,
      enum: ["schedule_h", "schedule_h1", "schedule_x", "narcotic"],
      required: true,
      index: true,
    },
    batchNumber: { type: String, required: true, trim: true },
    expiryDate: { type: Date },
    quantityDispensed: { type: Number, required: true, min: 1 },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    patientName: { type: String, required: true, trim: true },
    patientAddress: { type: String, default: "Address Not Recorded", trim: true },
    patientPhone: { type: String, trim: true },
    doctorId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    doctorName: { type: String, default: "Prescribing Physician", trim: true },
    doctorRegNumber: { type: String, default: "NMC-UNSPECIFIED", trim: true },
    prescriptionId: { type: Schema.Types.ObjectId, ref: "Prescription" },
    encounterId: { type: Schema.Types.ObjectId, ref: "Encounter" },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice" },
    dispensedBy: { type: Schema.Types.ObjectId, ref: "User" },
    dispensedByName: { type: String, default: "Registered Pharmacist", trim: true },
    dispensedAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

ScheduleH1RegisterSchema.index({ clinicId: 1, dispensedAt: -1 });
ScheduleH1RegisterSchema.index({ clinicId: 1, scheduleType: 1 });

ScheduleH1RegisterSchema.plugin(auditPlugin);

export const ScheduleH1Register = mongoose.model<IScheduleH1Register>(
  "ScheduleH1Register",
  ScheduleH1RegisterSchema
);

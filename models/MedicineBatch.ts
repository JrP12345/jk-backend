import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IMedicineBatch extends Document {
  medicineId: mongoose.Types.ObjectId;
  clinicId: mongoose.Types.ObjectId;
  batchNumber: string;
  expiryDate: Date;
  quantity: number;
  purchaseCost: number;
  sellingPrice: number;
  mrp?: number;
  hsnCode?: string;
  gstRate?: number;
  status: "active" | "expired" | "depleted";
  createdAt: Date;
  updatedAt: Date;
}

const medicineBatchSchema = new Schema<IMedicineBatch>(
  {
    medicineId: {
      type: Schema.Types.ObjectId,
      ref: "Medicine",
      required: true,
      index: true,
    },
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: true,
      index: true,
    },
    batchNumber: {
      type: String,
      required: true,
      trim: true,
    },
    expiryDate: {
      type: Date,
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
    },
    purchaseCost: {
      type: Number,
      required: true,
      min: 0,
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    mrp: {
      type: Number,
      min: 0,
    },
    hsnCode: {
      type: String,
      default: "3004",
    },
    gstRate: {
      type: Number,
      default: 5,
    },
    status: {
      type: String,
      enum: ["active", "expired", "depleted"],
      default: "active",
      index: true,
    },
  },
  { timestamps: true }
);

medicineBatchSchema.index({ medicineId: 1, expiryDate: 1, status: 1 });
medicineBatchSchema.index({ medicineId: 1, clinicId: 1, batchNumber: 1 }, { unique: true });

medicineBatchSchema.plugin(auditPlugin);

export const MedicineBatch = mongoose.model<IMedicineBatch>("MedicineBatch", medicineBatchSchema);

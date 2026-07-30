import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IInsuranceTariff extends Document {
  organizationId: mongoose.Types.ObjectId;
  tpaName: string;
  serviceCode: string;
  serviceName: string;
  agreedRate: number;
  isDisallowed: boolean;
  disallowedReason?: string;
  coPayPercentage: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const insuranceTariffSchema = new Schema<IInsuranceTariff>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    tpaName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    serviceCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    serviceName: {
      type: String,
      required: true,
      trim: true,
    },
    agreedRate: {
      type: Number,
      required: true,
      min: 0,
    },
    isDisallowed: {
      type: Boolean,
      default: false,
    },
    disallowedReason: {
      type: String,
      trim: true,
    },
    coPayPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

insuranceTariffSchema.index({ organizationId: 1, tpaName: 1, serviceCode: 1 }, { unique: true });

insuranceTariffSchema.plugin(auditPlugin);

export const InsuranceTariff = mongoose.model<IInsuranceTariff>("InsuranceTariff", insuranceTariffSchema);

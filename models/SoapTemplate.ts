import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface ISoapTemplate extends Document {
  title: string;
  specialty: string;
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
  createdBy?: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const soapTemplateSchema = new Schema<ISoapTemplate>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    specialty: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    subjective: { type: String, default: "" },
    objective: { type: String, default: "" },
    assessment: { type: String, default: "" },
    plan: { type: String, default: "" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    isPublic: { type: Boolean, default: true },
  },
  { timestamps: true }
);

soapTemplateSchema.plugin(auditPlugin);

export const SoapTemplate = mongoose.model<ISoapTemplate>("SoapTemplate", soapTemplateSchema);

import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IOpdPrescriptionItem {
  name: string;
  dosage: string;
  duration: string;
  instructions?: string;
}

export interface IOpdTemplate extends Document {
  title: string;
  specialty: string;
  symptoms: string;
  diagnosis: string;
  prescriptions: IOpdPrescriptionItem[];
  advice?: string;
  followUpRecommended?: boolean;
  followUpTimeline?: string;
  followUpNotes?: string;
  doctorId?: mongoose.Types.ObjectId;
  clinicId?: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const opdPrescriptionItemSchema = new Schema<IOpdPrescriptionItem>(
  {
    name: { type: String, required: true, trim: true },
    dosage: { type: String, required: true, trim: true },
    duration: { type: String, required: true, trim: true },
    instructions: { type: String, default: "" },
  },
  { _id: false }
);

const opdTemplateSchema = new Schema<IOpdTemplate>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    specialty: {
      type: String,
      default: "General Medicine",
      trim: true,
      index: true,
    },
    symptoms: { type: String, default: "" },
    diagnosis: { type: String, default: "" },
    prescriptions: { type: [opdPrescriptionItemSchema], default: [] },
    advice: { type: String, default: "" },
    followUpRecommended: { type: Boolean, default: false },
    followUpTimeline: { type: String, default: "" },
    followUpNotes: { type: String, default: "" },
    doctorId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    isPublic: { type: Boolean, default: false },
  },
  { timestamps: true }
);

opdTemplateSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

opdTemplateSchema.set("toJSON", {
  virtuals: true,
  transform: (_, ret: Record<string, any>) => {
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

opdTemplateSchema.plugin(auditPlugin);

export const OpdTemplate = mongoose.model<IOpdTemplate>("OpdTemplate", opdTemplateSchema);

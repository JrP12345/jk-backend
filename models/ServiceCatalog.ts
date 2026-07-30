import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface IServiceCatalog extends Document {
  organizationId: mongoose.Types.ObjectId;
  clinicId?: mongoose.Types.ObjectId;
  code: string;
  name: string;
  department: string;
  category: "consultation" | "procedure" | "lab_test" | "radiology" | "bed_charge" | "pharmacy" | "nursing" | "other";
  price: number;
  hsnSacCode?: string;
  gstRate: number;
  isActive: boolean;
  description?: string;
  createdAt: Date;
  updatedAt: Date;
}

const serviceCatalogSchema = new Schema<IServiceCatalog>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    clinicId: {
      type: Schema.Types.ObjectId,
      ref: "Clinic",
      required: false,
      index: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    department: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["consultation", "procedure", "lab_test", "radiology", "bed_charge", "pharmacy", "nursing", "other"],
      default: "other",
      required: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    hsnSacCode: {
      type: String,
      trim: true,
      default: "999312", // Default SAC code for Human Health Services
    },
    gstRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 28,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to ensure uniqueness of code within an organization
serviceCatalogSchema.index({ organizationId: 1, code: 1 }, { unique: true });
serviceCatalogSchema.index({ organizationId: 1, category: 1, isActive: 1 });

serviceCatalogSchema.plugin(auditPlugin);

export const ServiceCatalog = mongoose.model<IServiceCatalog>("ServiceCatalog", serviceCatalogSchema);

import mongoose, { Schema, Document } from "mongoose";

export interface IModuleRegistry extends Document {
  organizationId: mongoose.Types.ObjectId;
  moduleKey: string;
  enabled: boolean;
  priority: "P1" | "P2" | "P3";
  label: string;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ModuleRegistrySchema = new Schema<IModuleRegistry>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      index: true,
    },
    moduleKey: {
      type: String,
      required: true,
      trim: true,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    priority: {
      type: String,
      enum: ["P1", "P2", "P3"],
      required: true,
    },
    label: {
      type: String,
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

// One record per module per organization
ModuleRegistrySchema.index({ organizationId: 1, moduleKey: 1 }, { unique: true });

ModuleRegistrySchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ModuleRegistrySchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ModuleRegistry =
  mongoose.models.ModuleRegistry ||
  mongoose.model<IModuleRegistry>("ModuleRegistry", ModuleRegistrySchema);

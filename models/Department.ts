import mongoose, { Schema, Document } from "mongoose";

export interface IDepartment extends Document {
  organizationId: mongoose.Types.ObjectId;
  clinicId?: mongoose.Types.ObjectId;
  name: string;
  code: string;
  description?: string;
  headDoctorId?: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const DepartmentSchema = new Schema<IDepartment>(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    description: { type: String },
    headDoctorId: { type: Schema.Types.ObjectId, ref: "User" },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

DepartmentSchema.index({ organizationId: 1, code: 1 }, { unique: true });

export const Department = mongoose.models.Department || mongoose.model<IDepartment>("Department", DepartmentSchema);

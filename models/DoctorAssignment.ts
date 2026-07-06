import mongoose, { Schema } from "mongoose";

const DoctorAssignmentSchema = new Schema({
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  workingHours: { type: String, required: true }, // JSON schedule slots string
  fees: { type: Number, required: true },
  appointmentDuration: { type: Number, default: 15 }, // minutes
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// A doctor cannot have duplicate assignments to the same clinic
DoctorAssignmentSchema.index({ doctorId: 1, clinicId: 1 }, { unique: true });

DoctorAssignmentSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

DoctorAssignmentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const DoctorAssignment = mongoose.model("DoctorAssignment", DoctorAssignmentSchema);

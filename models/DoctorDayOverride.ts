import mongoose, { Schema } from "mongoose";

const DoctorDayOverrideSchema = new Schema(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    date: { type: String, required: true, index: true }, // Format: "YYYY-MM-DD"
    status: {
      type: String,
      enum: ["available", "unavailable", "delayed", "extended"],
      default: "unavailable",
      required: true,
    },
    effectiveStartTime: { type: String }, // e.g. "10:30"
    effectiveEndTime: { type: String },   // e.g. "15:00"
    reason: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// One active override per doctor per clinic per day
DoctorDayOverrideSchema.index({ clinicId: 1, doctorId: 1, date: 1 }, { unique: true });

DoctorDayOverrideSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

DoctorDayOverrideSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const DoctorDayOverride = mongoose.model("DoctorDayOverride", DoctorDayOverrideSchema);

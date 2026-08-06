import mongoose, { Schema } from "mongoose";

const ShiftRosterSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    departmentId: { type: Schema.Types.ObjectId, ref: "Department", index: true },
    staffId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    staffName: { type: String, required: true },
    staffRole: { type: String, enum: ["Nurse", "Doctor", "Technician", "Admin", "Pharmacist"], default: "Nurse", index: true },
    shiftDate: { type: Date, required: true, index: true },
    shiftType: {
      type: String,
      enum: ["morning", "evening", "night", "general", "on_call"],
      default: "morning",
      index: true,
    },
    startTime: { type: String, default: "07:00" },
    endTime: { type: String, default: "15:00" },
    ward: { type: String, default: "General Ward" },
    assignedPatientsCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["scheduled", "checked_in", "checked_out", "absent", "swapped"],
      default: "scheduled",
      index: true,
    },
    checkInTime: { type: Date, default: null },
    checkOutTime: { type: Date, default: null },
    handoverNotes: { type: String, default: "" },
    overtimeHours: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

ShiftRosterSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ShiftRosterSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const ShiftRoster = mongoose.model("ShiftRoster", ShiftRosterSchema);

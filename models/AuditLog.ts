import mongoose, { Schema } from "mongoose";

const AuditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  action: { type: String, required: true, index: true }, // e.g. "APPOINTMENT_CREATE", "VIP_OVERRIDE", "STATUS_CHANGE"
  targetId: { type: Schema.Types.ObjectId, required: true },
  targetModel: { type: String, required: true }, // "Appointment" or "Patient"
  details: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

AuditLogSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

AuditLogSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const AuditLog = mongoose.model("AuditLog", AuditLogSchema);

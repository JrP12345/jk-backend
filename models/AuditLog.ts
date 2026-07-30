import mongoose, { Schema } from "mongoose";

const AuditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  action: { type: String, required: true, index: true }, // e.g. "APPOINTMENT_CREATE", "VIP_OVERRIDE", "PHI_READ_ACCESS"
  targetId: { type: Schema.Types.ObjectId },
  targetModel: { type: String }, // "Appointment", "ClinicalNote", "Patient"
  category: {
    type: String,
    enum: ["AUTH", "CLINICAL_READ", "CLINICAL_WRITE", "BILLING", "ADMIN"],
    default: "CLINICAL_WRITE",
    index: true,
  },
  ipAddress: { type: String, trim: true },
  userAgent: { type: String, trim: true },
  details: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now }
});

AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
AuditLogSchema.index({ category: 1, createdAt: -1 });

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

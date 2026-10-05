import mongoose, { Schema } from "mongoose";
import { redactAuditDetails } from "../utilities/auditRedaction.ts";

const AuditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
  action: { type: String, required: true, index: true }, // e.g. "APPOINTMENT_CREATE", "VIP_OVERRIDE", "PHI_READ_ACCESS", "DPDP_PII_ANONYMIZED"
  targetId: { type: Schema.Types.ObjectId },
  targetModel: { type: String }, // "Appointment", "ClinicalNote", "Patient", "DataBreachIncident"
  category: {
    type: String,
    enum: ["AUTH", "CLINICAL_READ", "CLINICAL_WRITE", "BILLING", "ADMIN", "COMPLIANCE_DPDP"],
    default: "CLINICAL_WRITE",
    index: true,
  },
  ipAddress: { type: String, trim: true },
  userAgent: { type: String, trim: true },
  details: { type: Schema.Types.Mixed },
  sequence: { type: Number, index: true },
  prevHash: { type: String, index: true },
  hash: { type: String, index: true },
  createdAt: { type: Date, default: Date.now }
});

AuditLogSchema.index({ organizationId: 1, createdAt: -1 });
AuditLogSchema.index({ organizationId: 1, sequence: 1 }, { unique: true });
AuditLogSchema.index({ category: 1, createdAt: -1 });
AuditLogSchema.index({ organizationId: 1, category: 1, createdAt: -1 });

// This model-level boundary protects both direct AuditLog.create calls and
// generic audit-plugin snapshots. It runs before the immutable hash is made.
AuditLogSchema.pre("validate", function() {
  this.details = redactAuditDetails(this.details);
});

// All creation paths are routed through the atomic append service below.
AuditLogSchema.pre("save", async function() {
  if (this.isNew && (!this.sequence || !this.hash)) throw new Error("Use AuditLog.create or recordAuditLog to append an audit entry");
});

AuditLogSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

AuditLogSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    // Legacy entries may pre-date the write-time boundary. Never expose their
    // raw detail snapshots through an API serialization.
    ret.details = redactAuditDetails(ret.details);
    if (ret.userId && typeof ret.userId === "object") {
      ret.userId = {
        id: String(ret.userId._id || ret.userId.id),
        role: ret.userId.role,
      };
    }
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", AuditLogSchema);

// Preserve the existing create API while giving every caller the same boundary.
(AuditLog as any).create = async function(documents: any, options?: any) {
  const { recordAuditLog } = await import("../services/AuditTrailService.ts");
  if (Array.isArray(documents)) {
    const results = [];
    for (const document of documents) results.push(await recordAuditLog(document, options));
    return results;
  }
  return recordAuditLog(documents, options);
};

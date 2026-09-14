import mongoose, { Schema } from "mongoose";
import { computeAuditHash, GENESIS_HASH } from "../utilities/auditCrypto.ts";
import { withChainLock } from "../utilities/auditLock.ts";

const AuditLogSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true, default: null },
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

// Automatic cryptographic hash chaining for all audit creations
AuditLogSchema.pre("save", async function() {
  if (this.isNew && (!this.sequence || !this.hash)) {
    const orgKey = this.organizationId ? String(this.organizationId) : "GLOBAL";
    await withChainLock(orgKey, async () => {
      const orgFilter = this.organizationId ? this.organizationId : null;
      const AuditLogModel = mongoose.models.AuditLog || mongoose.model("AuditLog");
      const lastEntry: any = await AuditLogModel.findOne({ organizationId: orgFilter })
        .sort({ sequence: -1 })
        .select("sequence hash")
        .lean();

      const sequence = (lastEntry?.sequence || 0) + 1;
      const prevHash = lastEntry?.hash || GENESIS_HASH;
      this.sequence = sequence;
      this.prevHash = prevHash;
      this.hash = computeAuditHash({
        sequence,
        prevHash,
        organizationId: this.organizationId,
        userId: this.userId,
        action: this.action as string,
        category: this.category as string,
        targetId: this.targetId,
        targetModel: this.targetModel as string,
        details: this.details,
        createdAt: this.createdAt || new Date(),
      });
    });
  }
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

export const AuditLog = mongoose.models.AuditLog || mongoose.model("AuditLog", AuditLogSchema);


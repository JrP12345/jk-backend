import mongoose, { Schema, Document } from "mongoose";

export interface IFamilyRelationship extends Document {
  userId: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
  relationship: "self" | "mother" | "father" | "son" | "daughter" | "spouse" | "guardian" | "other";
  status: "active" | "pending" | "revoked";
  identityClaim?: boolean;
  reviewedBy?: mongoose.Types.ObjectId;
  reviewedAt?: Date;
  reviewReason?: string;
  consentAuthority?: boolean;
  dataRightsAuthority?: boolean;
  authorityRevision?: number;
  authorityUseRevision?: number;
  organizationAuthorizations?: { organizationId: mongoose.Types.ObjectId; communication: boolean; consent: boolean; dataRights: boolean; revision: number; reviewedBy: mongoose.Types.ObjectId; reviewedAt: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

const FamilyRelationshipSchema = new Schema<IFamilyRelationship>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    relationship: {
      type: String,
      enum: ["self", "mother", "father", "son", "daughter", "spouse", "guardian", "other"],
      required: true,
    },
    status: { type: String, enum: ["active", "pending", "revoked"], default: "active" },
    identityClaim: { type: Boolean, default: false },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: Date,
    reviewReason: { type: String, maxlength: 500 },
    // Booking relationships alone do not authorize consent or data-rights actions.
    consentAuthority: { type: Boolean, default: false },
    dataRightsAuthority: { type: Boolean, default: false },
    authorityRevision: { type: Number, default: 0 },
    authorityUseRevision: { type: Number, default: 0 },
    // Separate, attributable authority for one organization. Legacy global flags
    // are retained for compatibility but never authorize the new privacy policy.
    organizationAuthorizations: [{
      _id: false,
      organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
      communication: { type: Boolean, default: false },
      consent: { type: Boolean, default: false },
      dataRights: { type: Boolean, default: false },
      revision: { type: Number, default: 0 },
      reviewedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
      reviewedAt: { type: Date, required: true },
    }],
  },
  { timestamps: true }
);

FamilyRelationshipSchema.index({ userId: 1, patientId: 1 }, { unique: true });

export const FamilyRelationship =
  mongoose.models.FamilyRelationship ||
  mongoose.model<IFamilyRelationship>("FamilyRelationship", FamilyRelationshipSchema);

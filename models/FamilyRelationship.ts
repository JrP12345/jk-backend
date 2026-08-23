import mongoose, { Schema, Document } from "mongoose";

export interface IFamilyRelationship extends Document {
  userId: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
  relationship: "self" | "mother" | "father" | "son" | "daughter" | "spouse" | "guardian" | "other";
  status: "active" | "pending" | "revoked";
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
  },
  { timestamps: true }
);

FamilyRelationshipSchema.index({ userId: 1, patientId: 1 }, { unique: true });

export const FamilyRelationship =
  mongoose.models.FamilyRelationship ||
  mongoose.model<IFamilyRelationship>("FamilyRelationship", FamilyRelationshipSchema);

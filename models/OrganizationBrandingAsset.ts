import mongoose, { Schema } from "mongoose";

// Metadata for public organization branding in the existing private R2 bucket.
// Clinical upload objects never enter this registry.
const schema = new Schema({
  ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", default: null },
  objectKey: { type: String, required: true, unique: true },
  contentType: { type: String, required: true },
  state: { type: String, enum: ["staged", "attached", "deleting"], default: "staged", required: true },
  expiresAt: { type: Date, required: true, index: true },
  lastCheckedAt: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

export const OrganizationBrandingAsset = mongoose.model("OrganizationBrandingAsset", schema);

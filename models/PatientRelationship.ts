import mongoose, { Schema } from "mongoose";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";

// Organization context for the canonical Patient; never a second identity.
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location" },
  ownerId: { type: Schema.Types.ObjectId, ref: "User" },
  revision: { type: Number, default: 0 },
  status: { type: String, enum: ["active", "archived"], default: "active" },
  contact: {
    phone: { type: String, trim: true }, email: { type: String, trim: true, lowercase: true },
    availability: { type: String, enum: ["unknown", "reachable", "unreachable", "invalid"], default: "unknown" },
    recipientType: { type: String, enum: ["patient", "family"], default: "patient" },
    familyRelationshipId: { type: Schema.Types.ObjectId, ref: "FamilyRelationship" },
    correctedAt: Date, correctedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  preferences: {
    language: { type: String, maxlength: 40 },
    preferredChannel: { type: String, enum: ["phone", "whatsapp", "email", "none"] },
    doNotContact: { type: Boolean, default: false },
  },
  privacyRequest: {
    status: { type: String, enum: ["requested", "under_review", "retained", "fulfilled", "rejected"] },
    requestedAt: Date, reviewedAt: Date, reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    retentionBasis: { type: String, maxlength: 200 },
  },
}, { timestamps: true });
schema.index({ organizationId: 1, patientId: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, ownerId: 1, updatedAt: -1, _id: -1 });
schema.plugin(tenantPlugin);
export const PatientRelationship = mongoose.models.PatientRelationship || mongoose.model("PatientRelationship", schema);

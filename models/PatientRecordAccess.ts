import mongoose, { Schema } from "mongoose";

const schema = new Schema({
  tokenHash: { type: String, required: true, unique: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  sessionId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const PatientRecordAccess = mongoose.models.PatientRecordAccess || mongoose.model("PatientRecordAccess", schema);

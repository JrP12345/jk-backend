import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  scope: { type: String, required: true },
  wamid: { type: String, required: true },
  phoneHash: { type: String, required: true },
  type: String,
  organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  locationId: { type: Schema.Types.ObjectId, ref: 'Location' },
  inquiryId: { type: Schema.Types.ObjectId, ref: 'Inquiry' },
  patientId: { type: Schema.Types.ObjectId, ref: 'Patient' },
  pendingReview: { type: Boolean, default: true },
  revision: { type: Number, default: 0 },
  reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  reviewedAt: Date,
  payloadCiphertext: { type: String, select: false },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 86400_000) },
}, { timestamps: true });
schema.index({ scope: 1, wamid: 1 }, { unique: true });
schema.index({ organizationId: 1, locationId: 1, pendingReview: 1, _id: -1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const WhatsAppInboundMessage = mongoose.model("WhatsAppInboundMessage", schema);

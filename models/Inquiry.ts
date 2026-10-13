import mongoose, { Schema } from "mongoose";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";

export const INQUIRY_SOURCES = ["unknown", "phone", "walk_in", "whatsapp", "website", "referral"] as const;
export const INQUIRY_CLOSE_REASONS = ["resolved", "not_proceeding", "unreachable", "duplicate_inquiry", "other"] as const;
const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location", required: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient" },
  callerName: { type: String, maxlength: 120, trim: true },
  phone: { type: String, maxlength: 30 },
  email: { type: String, maxlength: 200, trim: true, lowercase: true },
  source: { type: String, enum: INQUIRY_SOURCES, default: "unknown" },
  sourceEvidence: { type: String, enum: ["unknown", "staff_reported"], default: "unknown" },
  reasonForContact: { type: String, enum: ["booking", "reschedule", "cancellation", "service_question", "other", "unknown"], default: "unknown" },
  requestedService: { type: String, maxlength: 100, trim: true },
  status: { type: String, enum: ["open", "in_progress", "closed", "converted"], default: "open" },
  ownerId: { type: Schema.Types.ObjectId, ref: "User" },
  nextAction: { kind: { type: String, enum: ["contact", "review", "book"] }, dueAt: Date },
  closeReason: { type: String, enum: INQUIRY_CLOSE_REASONS },
  duplicateInquiryId: { type: Schema.Types.ObjectId, ref: "Inquiry" },
  closedAt: Date,
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment" },
  convertedAt: Date,
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  revision: { type: Number, default: 0 },
}, { timestamps: true });
schema.index({ organizationId: 1, locationId: 1, status: 1, _id: -1 });
schema.index({ organizationId: 1, locationId: 1, ownerId: 1, "nextAction.dueAt": 1, _id: -1 });
schema.index({ organizationId: 1, phone: 1, _id: -1 });
schema.plugin(tenantPlugin);
export const Inquiry = mongoose.models.Inquiry || mongoose.model("Inquiry", schema);

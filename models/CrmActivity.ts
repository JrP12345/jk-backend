import mongoose, { Schema } from "mongoose";
import { tenantPlugin } from "../utilities/tenantPlugin.ts";
import { encryptField, decryptField } from "../utilities/cryptoEnvelope.ts";

const schema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  locationId: { type: Schema.Types.ObjectId, ref: "Location" },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient" },
  inquiryId: { type: Schema.Types.ObjectId, ref: "Inquiry" },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment" },
  taskId: { type: Schema.Types.ObjectId, ref: "Task" },
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  kind: { type: String, required: true, maxlength: 60 },
  visibility: { type: String, enum: ["administrative", "consent", "privacy"], default: "administrative" },
  outcome: { type: String, maxlength: 60 },
  communication: {
    channel: { type: String, enum: ['phone', 'whatsapp', 'email'] },
    direction: { type: String, enum: ['inbound', 'outbound'] },
    source: { type: String, enum: ['staff_reported', 'provider_event'] },
    occurredAt: Date,
  },
  note: { type: String, set: encryptField, get: decryptField, select: false,
    validate: { validator: (value: string) => !value || decryptField(value).length <= 2000, message: "Note must be at most 2000 characters" } },
  consentChanges: [{ purpose: { type: String, maxlength: 60 }, status: { type: String, enum: ["GRANTED", "WITHDRAWN"] } }],
  revision: Number,
  eventKey: { type: String, maxlength: 200 },
}, { timestamps: { createdAt: true, updatedAt: false }, toJSON: { getters: true } });
schema.index({ organizationId: 1, patientId: 1, createdAt: -1, _id: -1 });
schema.index({ organizationId: 1, inquiryId: 1, createdAt: -1, _id: -1 });
schema.index({ organizationId: 1, eventKey: 1 }, { unique: true, partialFilterExpression: { eventKey: { $type: "string" } } });
schema.plugin(tenantPlugin);
export const CrmActivity = mongoose.models.CrmActivity || mongoose.model("CrmActivity", schema);

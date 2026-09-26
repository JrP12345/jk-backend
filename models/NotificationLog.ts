import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";
import { encrypt, decrypt } from "../utilities/encryption.ts";

export interface INotificationLog extends Document {
  organizationId?: mongoose.Types.ObjectId;
  recipientPhone: string;
  recipientName?: string;
  channel: "sms" | "whatsapp" | "email";
  templateId: string;
  messageContent: string;
  status: "queued" | "sending" | "accepted" | "sent" | "delivered" | "read" | "failed";
  providerMessageId?: string;
  metaMessageId?: string;
  idempotencyKey?: string;
  creditsDeducted?: number;
  rawResponse?: any;
  errorReason?: string;
  sentAt?: Date;
  deliveredAt?: Date;
  readAt?: Date;
  failedAt?: Date;
  pricing?: any;
  createdAt: Date;
}

const notificationLogSchema = new Schema<INotificationLog>(
  {
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
    },
    recipientPhone: {
      type: String,
      required: true,
      index: true,
    },
    recipientName: {
      type: String,
      trim: true,
    },
    channel: {
      type: String,
      enum: ["sms", "whatsapp", "email"],
      default: "whatsapp",
      index: true,
    },
    templateId: {
      type: String,
      required: true,
      index: true,
    },
    messageContent: {
      type: String,
      required: true,
      set: encrypt,
      get: decrypt,
    },
    status: {
      type: String,
      enum: ["queued", "sending", "accepted", "sent", "delivered", "read", "failed"],
      default: "queued",
      index: true,
    },
    providerMessageId: {
      type: String,
      index: true,
    },
    metaMessageId: {
      type: String,
      sparse: true,
      index: true,
    },
    idempotencyKey: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
    },
    creditsDeducted: {
      type: Number,
      default: 0,
    },
    rawResponse: {
      type: Schema.Types.Mixed,
    },
    errorReason: {
      type: String,
    },
    sentAt: Date,
    deliveredAt: Date,
    readAt: Date,
    failedAt: Date,
    pricing: Schema.Types.Mixed,
  },
  { timestamps: true }
);

notificationLogSchema.plugin(auditPlugin);
notificationLogSchema.index({ metaMessageId: 1 }, { unique: true, name: "whatsapp_wamid_unique", partialFilterExpression: { metaMessageId: { $type: "string" } } });
// Audit serialization must not copy bodies, names, full phones or provider payloads.
notificationLogSchema.set("toJSON", { transform: (_doc, value: any) => {
  value.recipientPhone = `••••${String(value.recipientPhone || "").slice(-4)}`;
  delete value.recipientName; delete value.messageContent; delete value.rawResponse;
  return value;
} });

export const NotificationLog = mongoose.model<INotificationLog>("NotificationLog", notificationLogSchema);

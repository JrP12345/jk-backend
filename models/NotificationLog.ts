import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface INotificationLog extends Document {
  organizationId?: mongoose.Types.ObjectId;
  recipientPhone: string;
  recipientName?: string;
  channel: "sms" | "whatsapp" | "email";
  templateId: string;
  messageContent: string;
  status: "queued" | "sent" | "delivered" | "read" | "failed";
  providerMessageId?: string;
  metaMessageId?: string;
  idempotencyKey?: string;
  creditsDeducted?: number;
  rawResponse?: any;
  errorReason?: string;
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
    },
    status: {
      type: String,
      enum: ["queued", "sent", "delivered", "read", "failed"],
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
  },
  { timestamps: true }
);

notificationLogSchema.plugin(auditPlugin);

export const NotificationLog = mongoose.model<INotificationLog>("NotificationLog", notificationLogSchema);

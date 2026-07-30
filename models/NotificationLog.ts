import mongoose, { Schema, Document } from "mongoose";
import { auditPlugin } from "../utilities/auditPlugin.ts";

export interface INotificationLog extends Document {
  recipientPhone: string;
  recipientName?: string;
  channel: "sms" | "whatsapp" | "email";
  templateId: string;
  messageContent: string;
  status: "queued" | "sent" | "delivered" | "failed";
  providerMessageId?: string;
  errorReason?: string;
  createdAt: Date;
}

const notificationLogSchema = new Schema<INotificationLog>(
  {
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
      enum: ["queued", "sent", "delivered", "failed"],
      default: "queued",
      index: true,
    },
    providerMessageId: {
      type: String,
    },
    errorReason: {
      type: String,
    },
  },
  { timestamps: true }
);

notificationLogSchema.plugin(auditPlugin);

export const NotificationLog = mongoose.model<INotificationLog>("NotificationLog", notificationLogSchema);

import mongoose, { Schema } from "mongoose";

export interface INotificationDelivery {
  notificationId: mongoose.Types.ObjectId;
  channel: "inApp" | "email" | "push" | "sms" | "socket";
  recipient: string;
  status: "pending" | "sent" | "delivered" | "failed";
  sentAt?: Date;
  error?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
}

const NotificationDeliverySchema = new Schema({
  notificationId: { type: Schema.Types.ObjectId, ref: "Notification", required: true, index: true },
  channel: {
    type: String,
    enum: ["inApp", "email", "push", "sms", "socket"],
    required: true,
  },
  recipient: { type: String, required: true },
  status: {
    type: String,
    enum: ["pending", "sent", "delivered", "failed"],
    default: "pending",
  },
  sentAt: { type: Date },
  error: { type: String },
  metadata: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now, index: true },
});

NotificationDeliverySchema.virtual("id").get(function () {
  return this._id.toHexString();
});

NotificationDeliverySchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const NotificationDelivery = mongoose.model<INotificationDelivery & mongoose.Document>(
  "NotificationDelivery",
  NotificationDeliverySchema
);

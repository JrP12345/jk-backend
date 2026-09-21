import mongoose, { Schema } from "mongoose";

export interface INotificationDelivery {
  notificationId: mongoose.Types.ObjectId;
  channel: "inApp" | "email" | "push" | "sms" | "socket";
  recipient: string;
  status: "pending" | "processing" | "retrying" | "sent" | "delivered" | "failed";
  sentAt?: Date;
  error?: string;
  metadata?: Record<string, any>;
  title?: string;
  message?: string;
  idempotencyKey?: string;
  attempts?: number;
  maxAttempts?: number;
  nextAttemptAt?: Date;
  lockedAt?: Date;
  lockedUntil?: Date;
  lockedBy?: string;
  replayCount?: number;
  lastReplayedAt?: Date;
  lastReplayedBy?: mongoose.Types.ObjectId;
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
    enum: ["pending", "processing", "retrying", "sent", "delivered", "failed"],
    default: "pending",
  },
  sentAt: { type: Date },
  error: { type: String },
  metadata: { type: Schema.Types.Mixed },
  // Durable external-delivery outbox fields. In-app deliveries leave these
  // empty; the standalone worker claims only email rows in pending/retrying.
  title: { type: String },
  message: { type: String },
  idempotencyKey: { type: String, unique: true, sparse: true, index: true },
  attempts: { type: Number, default: 0 },
  maxAttempts: { type: Number, default: 5 },
  nextAttemptAt: { type: Date, index: true },
  lockedAt: { type: Date },
  lockedUntil: { type: Date, index: true },
  lockedBy: { type: String, index: true },
  // A human replay is explicitly bounded and attributable. It receives a new
  // automatic retry budget without allowing an infinite operator retry loop.
  replayCount: { type: Number, default: 0 },
  lastReplayedAt: { type: Date },
  lastReplayedBy: { type: Schema.Types.ObjectId, ref: "User" },
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

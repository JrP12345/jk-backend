import mongoose, { Schema } from "mongoose";

export interface INotification {
  organizationId?: mongoose.Types.ObjectId;
  tenantId?: string;
  createdBy?: mongoose.Types.ObjectId;
  targetUser: mongoose.Types.ObjectId;
  category: "auth" | "organization" | "team" | "task" | "patient" | "billing" | "security" | "system";
  type: string;
  title: string;
  message: string;
  priority?: "low" | "medium" | "high" | "urgent";
  severity?: "info" | "success" | "warning" | "error";
  actionUrl?: string;
  icon?: string;
  metadata?: Record<string, any>;
  idempotencyKey?: string;
  snoozedUntil?: Date | null;
  pinned?: boolean;
  entityType?: string;
  entityId?: string;
  groupKey?: string;
  expiresAt?: Date;
  readAt?: Date | null;
  clickedAt?: Date | null;
  archived?: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
}

const NotificationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  tenantId: { type: String, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  targetUser: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  category: {
    type: String,
    enum: ["auth", "organization", "team", "task", "patient", "billing", "security", "system"],
    required: true,
    index: true,
  },
  type: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium",
  },
  severity: {
    type: String,
    enum: ["info", "success", "warning", "error"],
    default: "info",
  },
  actionUrl: { type: String },
  icon: { type: String },
  metadata: { type: Schema.Types.Mixed },
  idempotencyKey: { type: String, index: true, sparse: true },
  snoozedUntil: { type: Date, default: null, index: true },
  pinned: { type: Boolean, default: false, index: true },
  entityType: { type: String, index: true },
  entityId: { type: String, index: true },
  groupKey: { type: String, index: true },
  expiresAt: { type: Date },
  readAt: { type: Date, default: null, index: true },
  clickedAt: { type: Date, default: null },
  archived: { type: Boolean, default: false, index: true },
  deletedAt: { type: Date, default: null, index: true },
  createdAt: { type: Date, default: Date.now, index: true },
});

// Compound indexes for fast multi-tenant unread, pinned & inbox queries
NotificationSchema.index({ targetUser: 1, organizationId: 1, pinned: -1, archived: 1, deletedAt: 1, createdAt: -1 });
NotificationSchema.index({ targetUser: 1, organizationId: 1, readAt: 1, archived: 1, deletedAt: 1 });
NotificationSchema.index({ entityType: 1, entityId: 1 });
NotificationSchema.index({ title: "text", message: "text" });

NotificationSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

NotificationSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Notification = mongoose.model<INotification & mongoose.Document>("Notification", NotificationSchema);

import mongoose, { Schema } from "mongoose";

export interface INotificationPreference {
  userId: mongoose.Types.ObjectId;
  organizationId?: mongoose.Types.ObjectId;
  channels: {
    email: boolean;
    inApp: boolean;
  };
  categories: {
    auth: boolean;
    organization: boolean;
    team: boolean;
    task: boolean;
    patient: boolean;
    billing: boolean;
    security: boolean;
    system: boolean;
  };
  updatedAt: Date;
}

const NotificationPreferenceSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization" },
  channels: {
    email: { type: Boolean, default: true },
    inApp: { type: Boolean, default: true },
  },
  categories: {
    auth: { type: Boolean, default: true },
    organization: { type: Boolean, default: true },
    team: { type: Boolean, default: true },
    task: { type: Boolean, default: true },
    patient: { type: Boolean, default: true },
    billing: { type: Boolean, default: true },
    security: { type: Boolean, default: true },
    system: { type: Boolean, default: true },
  },
  updatedAt: { type: Date, default: Date.now },
});

NotificationPreferenceSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

NotificationPreferenceSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const NotificationPreference = mongoose.model<INotificationPreference & mongoose.Document>(
  "NotificationPreference",
  NotificationPreferenceSchema
);

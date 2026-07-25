import mongoose, { Schema } from "mongoose";

export interface INotificationTemplate {
  code: string;
  category: string;
  channel: "email" | "inApp" | "push" | "sms";
  subject?: string;
  body: string;
  variables: string[];
  isActive: boolean;
  createdAt: Date;
}

const NotificationTemplateSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true },
  category: { type: String, required: true },
  channel: {
    type: String,
    enum: ["email", "inApp", "push", "sms"],
    required: true,
  },
  subject: { type: String },
  body: { type: String, required: true },
  variables: [{ type: String }],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

NotificationTemplateSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

NotificationTemplateSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const NotificationTemplate = mongoose.model<INotificationTemplate & mongoose.Document>(
  "NotificationTemplate",
  NotificationTemplateSchema
);

import mongoose, { Schema } from "mongoose";

const MessageItemSchema = new Schema({
  id: { type: String, required: true },
  sender: { type: String, enum: ["user", "ai"], required: true },
  text: { type: String, required: true },
  citations: [{ type: String }],
  suggestedActions: [{
    type: { type: String },
    label: { type: String },
    targetUrl: { type: String },
    payload: { type: Schema.Types.Mixed }
  }],
  timestamp: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const AIChatSessionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", default: null, index: true },
  title: { type: String, default: "New Clinical Session", required: true },
  messages: [MessageItemSchema],
  status: { type: String, enum: ["active", "archived"], default: "active", index: true },
  deletedAt: { type: Date, default: null, index: true }
}, { timestamps: true });

AIChatSessionSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

AIChatSessionSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const AIChatSession = mongoose.model("AIChatSession", AIChatSessionSchema);

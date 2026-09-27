import mongoose, { Schema } from "mongoose";

const AIChatSessionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", default: null, index: true },
  title: { type: String, default: "New Clinical Session", required: true },
  status: { type: String, enum: ["active", "archived"], default: "active", index: true },
  retentionExpiresAt: { type: Date, default: null, index: true },
  deletedAt: { type: Date, default: null, index: true }
}, { timestamps: true });

AIChatSessionSchema.index({ organizationId: 1, userId: 1, deletedAt: 1, updatedAt: -1 });

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

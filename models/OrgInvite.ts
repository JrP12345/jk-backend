import mongoose, { Schema } from "mongoose";

const OrgInviteSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  email: { type: String, required: true, index: true },
  role: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  status: { type: String, enum: ["pending", "accepted", "expired"], default: "pending", index: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Auto-purge expired invitations via TTL index
OrgInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

OrgInviteSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

OrgInviteSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.tokenHash;
    return ret;
  },
});

export const OrgInvite = mongoose.model("OrgInvite", OrgInviteSchema);

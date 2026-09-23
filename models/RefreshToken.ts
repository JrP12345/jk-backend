import mongoose, { Schema } from "mongoose";

const ImpersonationSchema = new Schema({
  id: { type: Schema.Types.ObjectId, ref: "User", required: true },
  email: { type: String },
  name: { type: String },
  originalRole: { type: String, default: "root" },
}, { _id: false });

const RefreshTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  familyId: { type: String, required: true, index: true },
  generation: { type: Number, default: 1 },
  authVersion: { type: Number, default: 1 },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true },
  revoked: { type: Boolean, default: false, index: true },
  revocationReason: { type: String, enum: ["rotated", "displaced", "terminated", "logout", "reuse_detected"], default: "rotated" },
  replacedByTokenHash: { type: String, default: null },
  graceExpiresAt: { type: Date, default: null },
  ipAddress: { type: String, default: "" },
  userAgent: { type: String, default: "" },
  deviceName: { type: String, default: "Browser Session" },
  isGuest: { type: Boolean, default: false },
  impersonatedBy: { type: ImpersonationSchema, default: undefined, required: false },
  lastActiveAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Automatically remove expired tokens via MongoDB TTL index
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

RefreshTokenSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

RefreshTokenSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const RefreshToken = mongoose.model("RefreshToken", RefreshTokenSchema);

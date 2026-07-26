import mongoose, { Schema } from "mongoose";

const RefreshTokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  expiresAt: { type: Date, required: true },
  revoked: { type: Boolean, default: false },
  ipAddress: { type: String, default: "" },
  userAgent: { type: String, default: "" },
  deviceName: { type: String, default: "Browser Session" },
  lastActiveAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

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

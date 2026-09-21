import mongoose, { Schema } from "mongoose";

export const AUTH_METHOD_OPTIONS = ["email_password", "phone_otp", "email_otp", "both"] as const;
export type AuthMethod = (typeof AUTH_METHOD_OPTIONS)[number];

const UserSchema = new Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, sparse: true, index: true },
  password: { type: String },
  phone: { type: String, index: true },
  authMethod: { type: String, enum: AUTH_METHOD_OPTIONS, default: AUTH_METHOD_OPTIONS[0] },
  role: { type: String, required: true, index: true }, // "root" | "admin" | "doctor" | "receptionist" | "nurse" | "lab_tech" | "pharmacist" | "cashier" | "patient" | "family_member"
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { type: String },
  isEmailVerified: { type: Boolean, default: true }, // Defaults to true for admin/staff created by org; patient self-reg sets false
  emailVerificationToken: { type: String, sparse: true, index: true },
  emailVerificationExpires: { type: Date },
  passwordResetToken: { type: String, sparse: true, index: true },
  passwordResetExpires: { type: Date },
  failedLoginAttempts: { type: Number, default: 0 },
  lockoutUntil: { type: Date, default: null },
  image_url: { type: String, default: null },
  isActive: { type: Boolean, default: true },
}, { timestamps: true });

UserSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

UserSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    delete ret.password;
    return ret;
  }
});

export const User = mongoose.model("User", UserSchema);

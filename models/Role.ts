import mongoose, { Schema } from "mongoose";

const RoleSchema = new Schema({
  name: { type: String, required: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", default: null, index: true },
  description: { type: String },
  permissions: [{ type: String }], // List of permission codes
  isSystemRole: { type: Boolean, default: false },
  version: { type: Number, default: 1 }
});

// Scope unique role names to their tenant organization (or null for global system roles)
RoleSchema.index({ name: 1, organizationId: 1 }, { unique: true });

RoleSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

RoleSchema.post(["save", "findOneAndUpdate", "updateOne", "deleteOne"] as any, function () {
  (globalThis as any).__invalidateRoleCache?.();
});

export const Role = mongoose.model("Role", RoleSchema);

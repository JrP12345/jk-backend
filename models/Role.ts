import mongoose, { Schema } from "mongoose";

const RoleSchema = new Schema({
  name: { type: String, required: true, unique: true, index: true },
  description: { type: String },
  permissions: [{ type: String }], // List of permission codes
  isSystemRole: { type: Boolean, default: false }
});

RoleSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Role = mongoose.model("Role", RoleSchema);

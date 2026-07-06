import mongoose, { Schema } from "mongoose";

const PermissionSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  description: { type: String },
  category: { type: String, enum: ["administrative", "clinical", "billing", "diagnostics"], required: true }
});

PermissionSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Permission = mongoose.model("Permission", PermissionSchema);

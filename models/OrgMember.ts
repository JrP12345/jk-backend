import mongoose, { Schema } from "mongoose";

const OrgMemberSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  role: { type: String, required: true },
  joinedAt: { type: Date, default: Date.now }
});

OrgMemberSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

OrgMemberSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const OrgMember = mongoose.model("OrgMember", OrgMemberSchema);

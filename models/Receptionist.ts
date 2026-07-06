import mongoose, { Schema } from "mongoose";

const ReceptionistSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", index: true },
  shift: { type: String }
});

ReceptionistSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

ReceptionistSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Receptionist = mongoose.model("Receptionist", ReceptionistSchema);

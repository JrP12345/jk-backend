import mongoose, { Schema } from "mongoose";

const PatientSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  dob: { type: Date },
  gender: { type: String, enum: ["male", "female", "other"] },
  address: { type: String },
  allergies: [{ type: String }],
  conditions: [{ type: String }],
  medicalNotes: { type: String }
});

PatientSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

PatientSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Patient = mongoose.model("Patient", PatientSchema);

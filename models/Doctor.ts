import mongoose, { Schema } from "mongoose";

const DoctorSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  specialization: { type: String },
  qualification: { type: String },
  experience_years: { type: Number },
  fees: { type: Number, default: 0 },
  feeType: { type: String, enum: ["fixed", "post_consultation", "free"], default: "fixed" },
  timings: { type: String }, // JSON string of schedule
  working_days: { type: String }, // JSON string
  description: { type: String },
  image_url: { type: String },
  rating: { type: Number, default: 5 },
  reviewsCount: { type: Number, default: 0 },
  registrationNumber: { type: String, trim: true },
  digitalSignatureUrl: { type: String, trim: true },
  letterheadDefaultMode: { type: String, enum: ["plain_a4", "preprinted_stationery"], default: "plain_a4" },
  cabinNumber: { type: String, default: "Cabin 1" },
  isActive: { type: Boolean, default: true, index: true },
  languages: [{ type: String, default: "English" }]
});

DoctorSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

DoctorSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Doctor = mongoose.model("Doctor", DoctorSchema);

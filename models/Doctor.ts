import mongoose, { Schema } from "mongoose";

const DoctorSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  specialization: { type: String },
  qualification: { type: String },
  experience_years: { type: Number },
  fees: { type: Number },
  timings: { type: String }, // JSON string of schedule
  working_days: { type: String }, // JSON string
  description: { type: String },
  image_url: { type: String },
  rating: { type: Number, default: 5 },
  reviewsCount: { type: Number, default: 0 },
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

import mongoose, { Schema } from "mongoose";

const LabTestSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  name: { type: String, required: true, index: true },
  code: { type: String, required: true, trim: true },
  department: { type: String, required: true },
  sampleType: { type: String, required: true },
  price: { type: Number, required: true },
  normalRange: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

LabTestSchema.index({ clinicId: 1, code: 1 }, { unique: true });
LabTestSchema.index({ organizationId: 1, code: 1 });

LabTestSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

LabTestSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const LabTest = mongoose.model("LabTest", LabTestSchema);

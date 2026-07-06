import mongoose, { Schema } from "mongoose";

const LabOrderSchema = new Schema({
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // ordering doctor
  testId: { type: Schema.Types.ObjectId, ref: "LabTest", required: true, index: true },
  orderDate: { type: Date, default: Date.now, required: true },
  status: {
    type: String,
    enum: ["ordered", "sample-collected", "result-uploaded", "cancelled"],
    default: "ordered",
    index: true
  },
  resultValue: { type: String, default: "" },
  resultNotes: { type: String, default: "" },
  attachmentUrl: { type: String, default: "" },
  completedDate: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

LabOrderSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

LabOrderSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const LabOrder = mongoose.model("LabOrder", LabOrderSchema);

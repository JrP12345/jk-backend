import mongoose, { Schema } from "mongoose";

const AdmissionSchema = new Schema({
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  bedId: { type: Schema.Types.ObjectId, ref: "Bed", required: true, index: true },
  admissionDate: { type: Date, default: Date.now, required: true },
  dischargeDate: { type: Date, default: null },
  reasonForAdmission: { type: String, required: true },
  doctorInCharge: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  status: {
    type: String,
    enum: ["admitted", "discharged"],
    default: "admitted",
    index: true
  },
  notes: { type: String },
  createdAt: { type: Date, default: Date.now }
});

AdmissionSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

AdmissionSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Admission = mongoose.model("Admission", AdmissionSchema);

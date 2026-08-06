import mongoose, { Schema } from "mongoose";

const AppointmentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  appointmentTime: { type: Date, required: true, index: true },
  appointmentType: { type: String, enum: ["walk-in", "online", "reception", "qr"], required: true },
  status: { 
    type: String, 
    enum: ["pending", "confirmed", "checked-in", "in-consultation", "completed", "cancelled", "no-show"], 
    default: "pending",
    index: true
  },
  tokenNumber: { type: Number, required: true },
  queuePosition: { type: Number, index: true },
  duration: { type: Number, default: 15 },
  reasonForVisit: { 
    type: String, 
    enum: ["new_consultation", "follow_up", "routine_checkup", "second_opinion", "report_review"], 
    default: "new_consultation" 
  },
  notes: { type: String },
  followUpRecommended: { type: Boolean, default: false },
  followUpTimeline: { type: String },
  followUpNotes: { type: String },
  followUpForAppointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  symptoms: { type: String },
  diagnosis: { type: String },
  prescriptions: [{
    name: { type: String, required: true },
    dosage: { type: String, required: true },
    duration: { type: String, required: true }
  }],
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

AppointmentSchema.index({ clinicId: 1, doctorId: 1, appointmentTime: 1 });
AppointmentSchema.index({ organizationId: 1, appointmentTime: -1 });

AppointmentSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

AppointmentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Appointment = mongoose.model("Appointment", AppointmentSchema);

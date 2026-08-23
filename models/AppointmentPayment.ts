import mongoose, { Schema, Document } from "mongoose";

export interface IAppointmentPayment extends Document {
  appointmentId: mongoose.Types.ObjectId;
  invoiceId?: mongoose.Types.ObjectId;
  patientId: mongoose.Types.ObjectId;
  amount: number;
  currency: string;
  paymentMethod: "razorpay" | "pay_at_clinic" | "cash" | "upi" | "card";
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  status: "created" | "authorized" | "captured" | "failed" | "pay_at_clinic";
  idempotencyKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AppointmentPaymentSchema = new Schema<IAppointmentPayment>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", required: true, index: true },
    invoiceId: { type: Schema.Types.ObjectId, ref: "Invoice", index: true },
    patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    paymentMethod: {
      type: String,
      enum: ["razorpay", "pay_at_clinic", "cash", "upi", "card"],
      required: true,
    },
    razorpayOrderId: { type: String, index: true },
    razorpayPaymentId: { type: String },
    razorpaySignature: { type: String },
    status: {
      type: String,
      enum: ["created", "authorized", "captured", "failed", "pay_at_clinic"],
      default: "created",
    },
    idempotencyKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true }
);

AppointmentPaymentSchema.index({ appointmentId: 1, status: 1 });

export const AppointmentPayment =
  mongoose.models.AppointmentPayment ||
  mongoose.model<IAppointmentPayment>("AppointmentPayment", AppointmentPaymentSchema);

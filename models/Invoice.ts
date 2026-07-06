import mongoose, { Schema } from "mongoose";

const InvoiceItemSchema = new Schema({
  description: { type: String, required: true },
  amount: { type: Number, required: true },
  quantity: { type: Number, required: true, default: 1 }
});

const InvoiceSchema = new Schema({
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true },
  clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
  doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  items: [InvoiceItemSchema],
  subtotal: { type: Number, required: true },
  tax: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ["unpaid", "paid", "refunded"], 
    default: "unpaid",
    index: true 
  },
  paymentMethod: { 
    type: String, 
    enum: ["cash", "card", "upi", "net-banking", "insurance", "online"] 
  },
  paymentDate: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

InvoiceSchema.index({ clinicId: 1, status: 1 });

InvoiceSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

InvoiceSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Invoice = mongoose.model("Invoice", InvoiceSchema);

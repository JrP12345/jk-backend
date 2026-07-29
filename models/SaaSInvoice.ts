import mongoose, { Schema } from "mongoose";

const SaaSInvoiceSchema = new Schema({
  invoiceNumber: { type: String, required: true, unique: true, index: true },
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  subscriptionId: { type: Schema.Types.ObjectId, ref: "Subscription", required: true, index: true },
  paymentId: { type: Schema.Types.ObjectId, ref: "SubscriptionPayment", index: true },
  planName: { type: String, required: true },
  billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },
  subtotal: { type: Number, required: true },
  taxAmount: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  status: { type: String, enum: ["paid", "unpaid", "void", "refunded"], default: "paid", index: true },
  billingDetails: {
    orgName: { type: String, required: true },
    gstin: { type: String, default: null },
    address: { type: String, default: null },
    city: { type: String, default: null },
    email: { type: String, default: null },
  },
  pdfUrl: { type: String, default: null },
  paidAt: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

SaaSInvoiceSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

SaaSInvoiceSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const SaaSInvoice = mongoose.model("SaaSInvoice", SaaSInvoiceSchema);

import mongoose, { Schema } from "mongoose";

const SubscriptionPaymentSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  subscriptionId: { type: Schema.Types.ObjectId, ref: "Subscription", required: true, index: true },
  planId: { type: Schema.Types.ObjectId, ref: "SaaSPlan", required: true },
  razorpayOrderId: { type: String, required: true, unique: true, index: true },
  razorpayPaymentId: { type: String, default: null, sparse: true, index: true },
  razorpaySignature: { type: String, default: null },
  amount: { type: Number, required: true },
  currency: { type: String, default: "INR" },
  status: {
    type: String,
    enum: ["created", "captured", "failed", "refunded"],
    default: "created",
    index: true,
  },
  billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },
  idempotencyKey: { type: String, default: null, sparse: true, index: true },
  failureReason: { type: String, default: null },
  rawWebhookPayload: { type: Schema.Types.Mixed, default: null },
  paidAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

SubscriptionPaymentSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

SubscriptionPaymentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const SubscriptionPayment = mongoose.model("SubscriptionPayment", SubscriptionPaymentSchema);

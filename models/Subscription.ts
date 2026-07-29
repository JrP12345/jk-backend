import mongoose, { Schema } from "mongoose";

const SubscriptionSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  planId: { type: Schema.Types.ObjectId, ref: "SaaSPlan", required: true, index: true },
  status: {
    type: String,
    enum: ["trialing", "active", "payment_pending", "payment_failed", "cancelled", "expired"],
    default: "trialing",
    index: true,
  },
  billingCycle: { type: String, enum: ["monthly", "annual"], default: "monthly" },
  trialStartedAt: { type: Date, default: Date.now },
  trialEndsAt: { type: Date, required: true },
  currentPeriodStart: { type: Date, default: Date.now },
  currentPeriodEnd: { type: Date, required: true },
  cancelledAt: { type: Date, default: null },
  razorpaySubscriptionId: { type: String, default: null, index: true },
  razorpayCustomerId: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

SubscriptionSchema.index({ organizationId: 1, status: 1 });

SubscriptionSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

SubscriptionSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const Subscription = mongoose.model("Subscription", SubscriptionSchema);

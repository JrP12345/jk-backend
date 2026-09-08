import mongoose, { Schema } from "mongoose";

const CashierShiftSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    cashierName: { type: String, required: true },
    shiftDate: { type: String, required: true, index: true }, // "YYYY-MM-DD"
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date, default: Date.now },
    systemTotals: {
      cash: { type: Number, default: 0 },
      upi: { type: Number, default: 0 },
      card: { type: Number, default: 0 },
      other: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      invoiceCount: { type: Number, default: 0 },
    },
    actualCashCounted: { type: Number, required: true },
    cashVariance: { type: Number, required: true }, // actualCashCounted - systemTotals.cash
    varianceReason: { type: String, default: "" },
    handoverNotes: { type: String, default: "" },
    status: { type: String, enum: ["closed"], default: "closed", index: true },
  },
  { timestamps: true }
);

CashierShiftSchema.index({ clinicId: 1, shiftDate: 1 });

CashierShiftSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

CashierShiftSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const CashierShift = mongoose.model("CashierShift", CashierShiftSchema);

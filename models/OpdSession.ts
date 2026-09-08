import mongoose, { Schema } from "mongoose";

const OpdSessionSchema = new Schema(
  {
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    doctorId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    status: { type: String, enum: ["active", "ended"], default: "active", index: true },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    startedBy: { type: Schema.Types.ObjectId, ref: "User" },
    endedBy: { type: Schema.Types.ObjectId, ref: "User" },
    isOnBreak: { type: Boolean, default: false, index: true },
    breakReason: { type: String, default: "" },
    breakStartedAt: { type: Date, default: null },
    breakExpectedMinutes: { type: Number, default: 15 },
    reconciliationSummary: {
      standbyCount: { type: Number, default: 0 },
      waitingCount: { type: Number, default: 0 },
      completedCount: { type: Number, default: 0 },
      standbyAction: { type: String },
      waitingAction: { type: String },
      reconciledAt: { type: Date }
    }
  },
  { timestamps: true }
);

OpdSessionSchema.index({ clinicId: 1, doctorId: 1, date: 1 }, { unique: true });

OpdSessionSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

OpdSessionSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const OpdSession = mongoose.model("OpdSession", OpdSessionSchema);

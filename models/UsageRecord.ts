import mongoose, { Schema } from "mongoose";

const UsageRecordSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true, index: true },
  hospitalsCount: { type: Number, default: 0 },
  clinicsCount: { type: Number, default: 0 },
  doctorsCount: { type: Number, default: 0 },
  staffCount: { type: Number, default: 0 },
  patientsCount: { type: Number, default: 0 },
  appointmentsCount: { type: Number, default: 0 },
  storageUsedBytes: { type: Number, default: 0 },
  lastCalculatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

UsageRecordSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

UsageRecordSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

export const UsageRecord = mongoose.model("UsageRecord", UsageRecordSchema);

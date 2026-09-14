import mongoose, { Schema } from "mongoose";

const ConsentSchema = new Schema({
  patientId: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  fhirResourceType: { type: String, default: "Consent" },

  grantee: {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    doctorId: { type: Schema.Types.ObjectId, ref: "User" },
    facilityId: { type: String },
  },

  status: {
    type: String,
    enum: ["draft", "active", "rejected", "inactive", "entered_in_error"],
    default: "active",
    index: true,
  },

  scope: [
    {
      type: String,
      enum: ["READ_TIMELINE", "WRITE_ENCOUNTER", "VIEW_LABS", "VIEW_IMAGING", "EMERGENCY_OVERRIDE"],
    },
  ],

  period: {
    start: { type: Date, default: Date.now },
    end: { type: Date, required: true },
  },

  provision: {
    type: { type: String, enum: ["permit", "deny"], default: "permit" },
    purpose: [{ type: String, enum: ["TREATMENT", "EMERGENCY", "RESEARCH", "BILLING"] }],
  },

  audit: {
    grantedAt: { type: Date, default: Date.now },
    grantedVia: {
      type: String,
      enum: ["PATIENT_MOBILE_APP", "CLINIC_KIOSK_OTP", "DEFAULT_INITIAL_REGISTRATION"],
      default: "DEFAULT_INITIAL_REGISTRATION",
    },
    ipAddress: { type: String },
    emergencyReason: { type: String },
  },
});

ConsentSchema.index({ patientId: 1, "grantee.organizationId": 1, status: 1 });

ConsentSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

ConsentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const Consent = mongoose.model("Consent", ConsentSchema);

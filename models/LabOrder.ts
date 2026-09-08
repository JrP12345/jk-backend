import mongoose, { Schema } from "mongoose";

/**
 * LabOrder — diagnostic order document, extended for the Encounter domain.
 *
 * Lifecycle (explicit state machine — enforced by OrdersService):
 *
 *   ordered → sample-collected → processing → result-uploaded (terminal)
 *           → cancelled (any non-terminal state, mandatory cancellationReason)
 *
 * Result versioning is prepared via the result sub-document structure.
 * verifiedBy is reserved for future two-step verification workflows.
 */
const LabOrderSchema = new Schema({
  // ─── Multi-Tenant Isolation ────────────────────────────────────
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  clinicId:       { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },

  // ─── Encounter Aggregate Root Linkage ──────────────────────────
  // Optional for backward compatibility with pre-v1.6 orders
  encounterId: { type: Schema.Types.ObjectId, ref: "Encounter", index: true, default: null },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment", index: true, default: null },

  // ─── Clinical Context ──────────────────────────────────────────
  patientId:      { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
  testId:         { type: Schema.Types.ObjectId, ref: "LabTest", required: true, index: true },
  priority:       { type: String, enum: ["routine", "urgent", "stat"], default: "routine" },
  clinicalReason: { type: String, default: "" }, // Why the test was ordered

  // ─── Accountability (distinct roles) ───────────────────────────
  orderedBy:   { type: Schema.Types.ObjectId, ref: "User", index: true, default: null },
  collectedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  resultedBy:  { type: Schema.Types.ObjectId, ref: "User", default: null },
  verifiedBy:  { type: Schema.Types.ObjectId, ref: "User", default: null }, // reserved for two-step verification

  // Primary Ordering Physician reference
  doctorId: { type: Schema.Types.ObjectId, ref: "User", index: true },

  // ─── Lifecycle Status ──────────────────────────────────────────
  status: {
    type: String,
    enum: ["ordered", "sample-collected", "processing", "result-uploaded", "cancelled"],
    default: "ordered",
    index: true,
  },

  // ─── Lifecycle Timestamps ──────────────────────────────────────
  orderDate:          { type: Date, default: Date.now },
  sampleCollectedAt:  { type: Date, default: null },
  processingStartedAt:{ type: Date, default: null },
  resultedAt:         { type: Date, default: null },
  completedDate:      { type: Date, default: null }, // alias for resultedAt

  // ─── Structured Result (replaces plain resultValue string) ─────
  // Prepared for future result versioning (corrected reports).
  result: {
    value:          { type: String, default: "" },
    unit:           { type: String, default: "" },          // e.g. "mmol/L", "g/dL"
    referenceRange: { type: String, default: "" },          // e.g. "3.5–5.0"
    interpretation: {
      type: String,
      enum: ["normal", "low", "high", "critical", "indeterminate", ""],
      default: "",
    },
    isAbnormal:    { type: Boolean, default: false },       // true if outside reference range
    notes:         { type: String, default: "" },
    attachmentUrl: { type: String, default: "" },
  },

  // Flat text result representations
  resultValue:   { type: String, default: "" },
  resultNotes:   { type: String, default: "" },
  attachmentUrl: { type: String, default: "" },

  // ─── Cancellation Accountability ───────────────────────────────
  cancellationReason: { type: String, default: "" }, // required when status = "cancelled"
  deletedAt: { type: Date, default: null, index: true },

  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

LabOrderSchema.index({ appointmentId: 1, status: 1 });

LabOrderSchema.virtual("id").get(function() {
  return this._id.toHexString();
});

LabOrderSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const LabOrder = mongoose.model("LabOrder", LabOrderSchema);


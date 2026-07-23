import mongoose, { Schema } from "mongoose";

/**
 * MedicationAdministration — the core MAR document.
 *
 * Models a single dose event in the medication administration record.
 * Every status transition is preserved through audit logging (via auditPlugin),
 * giving the system a legally defensible administration history.
 *
 * Status lifecycle (explicit state machine — enforced by MARService):
 *
 *   scheduled → administered  (dose given)
 *             → refused       (patient declined)
 *             → held          (clinician decision)
 *             → missed        (scheduled time elapsed without action)
 *
 * Terminal states (administered, refused, held, missed) cannot transition
 * back to scheduled without an explicit correction workflow.
 */
const MedicationAdministrationSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  clinicId:       { type: Schema.Types.ObjectId, ref: "Clinic",        required: true, index: true },
  encounterId:    { type: Schema.Types.ObjectId, ref: "Encounter",     required: true, index: true },
  prescriptionId: { type: Schema.Types.ObjectId, ref: "Prescription",  required: true, index: true },
  patientId:      { type: Schema.Types.ObjectId, ref: "Patient",       required: true, index: true },

  // ─── Medication Identity ────────────────────────────────────────
  // Denormalized for audit integrity — preserves the name even if
  // the Medicine catalog entry is later updated or removed.
  medicineName: { type: String, required: true },

  // ─── Dose Tracking (prescribed vs administered) ─────────────────
  // Captures clinical variance: how often are ordered doses modified?
  prescribedDose:   { type: String, required: true },  // from Prescription.dosage
  doseGiven:        { type: String, default: "" },      // actual dose administered

  // ─── Route of Administration ────────────────────────────────────
  route: {
    type: String,
    enum: ["oral", "iv", "im", "topical", "inhaled", "sublingual", "rectal", "other"],
    required: true,
  },

  // ─── Scheduling & Timing ───────────────────────────────────────
  scheduledTime:    { type: Date, required: true },  // planned time
  administeredTime: { type: Date, default: null },    // actual time (null until administered)

  // ─── Accountability (two distinct concepts) ─────────────────────
  // administeredBy: who physically gave the medication
  // recordedBy:     who documented the event (may differ in busy wards)
  administeredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  recordedBy:     { type: Schema.Types.ObjectId, ref: "User", required: true },

  // ─── Lifecycle Status ──────────────────────────────────────────
  status: {
    type: String,
    enum: ["scheduled", "administered", "refused", "held", "missed"],
    default: "scheduled",
    index: true,
  },

  // ─── Conditional Reason Fields ─────────────────────────────────
  refusalReason: { type: String, default: "" }, // required when status = "refused"
  holdReason:    { type: String, default: "" }, // required when status = "held"

  // ─── Optional Observation Linkage ──────────────────────────────
  // Future-proofs workflows: insulin after glucose, O2 after SpO2 etc.
  observationId: { type: Schema.Types.ObjectId, ref: "Observation", default: null },

  // ─── Clinical Notes ────────────────────────────────────────────
  notes: { type: String, default: "" },

  createdAt: { type: Date, default: Date.now },
});

MedicationAdministrationSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

MedicationAdministrationSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const MedicationAdministration =
  mongoose.models.MedicationAdministration ||
  mongoose.model("MedicationAdministration", MedicationAdministrationSchema);

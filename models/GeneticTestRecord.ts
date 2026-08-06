import mongoose, { Schema } from "mongoose";

const VariantSchema = new Schema(
  {
    geneName: { type: String, required: true }, // e.g., BRCA1, TP53, MYH7
    variantHGVSc: { type: String, required: true }, // e.g., c.5266dupC (p.Gln1756Profs*74)
    classification: {
      type: String,
      enum: ["pathogenic", "likely_pathogenic", "variant_uncertain_significance", "likely_benign", "benign"],
      default: "variant_uncertain_significance",
    },
  },
  { _id: false }
);

const GeneticTestRecordSchema = new Schema(
  {
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    clinicId: { type: Schema.Types.ObjectId, ref: "Clinic", required: true, index: true },
    sampleId: { type: String, required: true, unique: true, index: true }, // e.g. GEN-2026-9901
    patientName: { type: String, required: true, index: true },
    patientAge: { type: Number, required: true },
    panelType: {
      type: String,
      enum: ["hereditary_cancer", "cardiovascular_genomics", "rare_disease_exome", "pharmacogenomics", "carrier_screening"],
      required: true,
      index: true,
    },
    sequencingPlatform: { type: String, default: "Illumina NovaSeq 6000" },
    geneVariants: [VariantSchema],
    actionableInsights: { type: String, default: "" },
    geneticCounselingStatus: {
      type: String,
      enum: ["pending_sequencing", "variant_analysis", "counseling_scheduled", "completed"],
      default: "pending_sequencing",
      index: true,
    },
    geneticCounselorName: { type: String, default: "" },
    sampleCollectedDate: { type: Date, default: Date.now, index: true },
    reportDate: { type: Date, default: null },
    notes: { type: String, default: "" },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

GeneticTestRecordSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

GeneticTestRecordSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const GeneticTestRecord = mongoose.model("GeneticTestRecord", GeneticTestRecordSchema);

import mongoose, { Schema } from "mongoose";

export const BREACH_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type BreachSeverity = (typeof BREACH_SEVERITIES)[number];

export const BREACH_STATUSES = [
  "DETECTED",
  "TRIAGED",
  "CONTAINED",
  "REPORTED_TO_DPBI",
  "NOTIFIED_AFFECTED_USERS",
  "RESOLVED",
] as const;
export type BreachStatus = (typeof BREACH_STATUSES)[number];

export const DATA_CATEGORIES = ["PII", "CLINICAL_PHI", "FINANCIAL_BILLING", "CREDENTIALS"] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

const DataBreachIncidentSchema = new Schema(
  {
    incidentId: { type: String, required: true, unique: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    reportedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    rootCause: { type: String },
    remediationSteps: { type: String },

    severity: {
      type: String,
      enum: BREACH_SEVERITIES,
      default: "MEDIUM",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: BREACH_STATUSES,
      default: "DETECTED",
      required: true,
      index: true,
    },

    dataCategoriesExposed: [
      {
        type: String,
        enum: DATA_CATEGORIES,
        required: true,
      },
    ],

    affectedSubjectsCount: { type: Number, default: 0 },
    affectedPatientIds: [{ type: Schema.Types.ObjectId, ref: "Patient" }],

    discoveredAt: { type: Date, default: Date.now, required: true },
    containedAt: { type: Date },
    reportedToBoardAt: { type: Date },
    notifiedSubjectsAt: { type: Date },

    dpbiReportPayload: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

DataBreachIncidentSchema.index({ organizationId: 1, createdAt: -1 });
DataBreachIncidentSchema.index({ status: 1, severity: 1 });

DataBreachIncidentSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

DataBreachIncidentSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const DataBreachIncident = mongoose.model("DataBreachIncident", DataBreachIncidentSchema);

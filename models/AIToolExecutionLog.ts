import mongoose, { Schema } from "mongoose";

const AIToolExecutionLogSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
  requestedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  approvedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  sessionId: { type: String, default: "general" },
  toolName: { type: String, required: true, index: true },
  inputPayload: { type: Schema.Types.Mixed, required: true },
  status: {
    type: String,
    enum: ["pending_approval", "approved_and_executed", "rejected"],
    default: "pending_approval",
    index: true
  },
  executionResult: { type: Schema.Types.Mixed, default: null },
  executedAt: { type: Date, default: null }
}, { timestamps: true });

export const AIToolExecutionLog = mongoose.model("AIToolExecutionLog", AIToolExecutionLogSchema);

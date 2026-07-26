import mongoose, { Schema } from "mongoose";

const AIPromptTemplateSchema = new Schema({
  key: { type: String, required: true, index: true }, // e.g. CLINICAL_HEALTH_ASSISTANT, SOAP_NOTE_GENERATOR
  version: { type: String, required: true }, // e.g. 1.0.0, 1.1.0
  status: { type: String, enum: ["draft", "review", "active", "archived"], default: "draft", index: true },
  title: { type: String, required: true },
  description: { type: String, default: "" },
  systemPrompt: { type: String, required: true },
  userPromptTemplate: { type: String, default: "{{query}}" },
  temperature: { type: Number, default: 0.2 },
  requiredVariables: [{ type: String }],
  approvedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
  approvedAt: { type: Date, default: null },
  createdById: { type: Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

AIPromptTemplateSchema.index({ key: 1, version: 1 }, { unique: true });

export const AIPromptTemplate = mongoose.model("AIPromptTemplate", AIPromptTemplateSchema);

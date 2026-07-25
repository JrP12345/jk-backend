import mongoose, { Schema } from "mongoose";

const OnboardingDraftSchema = new Schema({
  token: { type: String, required: true, unique: true, index: true },
  step: { type: Number, default: 0 },
  formData: { type: Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now }
});

export const OnboardingDraft = mongoose.model("OnboardingDraft", OnboardingDraftSchema);

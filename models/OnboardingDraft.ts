import mongoose, { Schema } from "mongoose";

const OnboardingDraftSchema = new Schema({
  token: { type: String, required: true, unique: true, index: true },
  step: { type: Number, default: 0 },
  formData: { type: Schema.Types.Mixed, default: {} },
  updatedAt: { type: Date, default: Date.now }
});

// Abandoned onboarding drafts automatically expire after 7 days (604800 seconds)
OnboardingDraftSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 604800 });

export const OnboardingDraft = mongoose.model("OnboardingDraft", OnboardingDraftSchema);

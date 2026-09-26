import mongoose, { Schema } from "mongoose";
const schema = new Schema({
  scope: { type: String, required: true },
  metaId: String,
  name: { type: String, required: true },
  language: { type: String, required: true },
  status: String,
  category: String,
  components: Schema.Types.Mixed,
  lastMetaEventAt: Date,
}, { timestamps: true });
schema.index({ scope: 1, name: 1, language: 1 }, { unique: true });
export const WhatsAppTemplate = mongoose.model("WhatsAppTemplate", schema);

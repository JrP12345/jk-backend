import mongoose, { Schema } from "mongoose";

export interface IAIChatMessage {
  sessionId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  sender: "user" | "ai";
  text: string;
  citations?: string[];
  suggestedActions?: Array<{
    type?: string;
    label?: string;
    targetUrl?: string;
    payload?: any;
  }>;
  sequence: number;
  tokens?: {
    prompt?: number;
    completion?: number;
    total?: number;
  };
  toolCalls?: any[];
  timestamp: string;
  createdAt: Date;
}

const AIChatMessageSchema = new Schema(
  {
    sessionId: { type: Schema.Types.ObjectId, ref: "AIChatSession", required: true, index: true },
    organizationId: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sender: { type: String, enum: ["user", "ai"], required: true },
    text: { type: String, required: true },
    citations: [{ type: String }],
    suggestedActions: [
      {
        type: { type: String },
        label: { type: String },
        targetUrl: { type: String },
        payload: { type: Schema.Types.Mixed },
      },
    ],
    sequence: { type: Number, required: true },
    tokens: {
      prompt: { type: Number },
      completion: { type: Number },
      total: { type: Number },
    },
    toolCalls: [{ type: Schema.Types.Mixed }],
    timestamp: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Deterministic compound index for fast sequential message retrieval & unique ordering per session
AIChatMessageSchema.index({ sessionId: 1, sequence: 1 }, { unique: true });
// Compound index for deterministic cursor pagination: { sessionId, createdAt: -1, _id: -1 }
AIChatMessageSchema.index({ sessionId: 1, createdAt: -1, _id: -1 });
// Tenant index
AIChatMessageSchema.index({ organizationId: 1, createdAt: -1 });

AIChatMessageSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

AIChatMessageSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const AIChatMessage = mongoose.model("AIChatMessage", AIChatMessageSchema);

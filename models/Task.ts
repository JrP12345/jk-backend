import mongoose, { Schema } from "mongoose";

export interface ITask {
  organizationId?: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "review" | "completed";
  priority: "low" | "medium" | "high" | "urgent";
  dueDate?: Date;
  assignedTo?: mongoose.Types.ObjectId;
  kind?: string;
  patientId?: mongoose.Types.ObjectId;
  locationId?: mongoose.Types.ObjectId;
  revision?: number;
  dedupeKey?: string;
  inquiryId?: mongoose.Types.ObjectId;
  appointmentId?: mongoose.Types.ObjectId;
  orderId?: mongoose.Types.ObjectId;
  sourceRevision?: number;
  snoozedUntil?: Date;
  completedAt?: Date;
  outcome?: string;
  needsAssignment?: boolean;
  resultAppointmentId?: mongoose.Types.ObjectId;
  followUpReview?: 'ambiguous' | 'legacy';
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TaskSchema = new Schema({
  organizationId: { type: Schema.Types.ObjectId, ref: "Organization", index: true },
  title: { type: String, required: true },
  description: { type: String },
  status: {
    type: String,
    enum: ["todo", "in_progress", "review", "completed"],
    default: "todo",
    index: true,
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium",
  },
  dueDate: { type: Date, index: true },
  assignedTo: { type: Schema.Types.ObjectId, ref: "User", index: true },
  kind: { type: String, default: "general", index: true },
  patientId: { type: Schema.Types.ObjectId, ref: "Patient" },
  locationId: { type: Schema.Types.ObjectId, ref: "Location" },
  revision: { type: Number, default: 0 },
  dedupeKey: String,
  inquiryId: { type: Schema.Types.ObjectId, ref: "Inquiry" },
  appointmentId: { type: Schema.Types.ObjectId, ref: "Appointment" },
  orderId: { type: Schema.Types.ObjectId, ref: "LabOrder" },
  sourceRevision: Number,
  snoozedUntil: Date,
  completedAt: Date,
  outcome: { type: String, maxlength: 60 },
  needsAssignment: { type: Boolean, default: false },
  resultAppointmentId: { type: Schema.Types.ObjectId, ref: "Appointment" },
  followUpReview: { type: String, enum: ['ambiguous', 'legacy'] },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: function (this: { kind?: string }) { return !String(this.kind || 'general').startsWith('crm_'); } },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

TaskSchema.index({ organizationId: 1, status: 1 });
TaskSchema.index({ organizationId: 1, locationId: 1, assignedTo: 1, status: 1, dueDate: 1, _id: 1 });
TaskSchema.index({ organizationId: 1, dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } });

TaskSchema.virtual("id").get(function () {
  return this._id.toHexString();
});

TaskSchema.set("toJSON", {
  virtuals: true,
  transform: (doc, ret: any) => {
    ret.id = ret._id.toString();
    delete ret._id;
    delete ret.__v;
    return ret;
  },
});

export const TaskModel = mongoose.model<ITask & mongoose.Document>("Task", TaskSchema);

import mongoose, { Schema } from "mongoose";

export interface ITask {
  organizationId?: mongoose.Types.ObjectId;
  title: string;
  description?: string;
  status: "todo" | "in_progress" | "review" | "completed";
  priority: "low" | "medium" | "high" | "urgent";
  dueDate?: Date;
  assignedTo: mongoose.Types.ObjectId;
  createdBy: mongoose.Types.ObjectId;
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
  assignedTo: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

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

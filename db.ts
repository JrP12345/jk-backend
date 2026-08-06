import mongoose from "mongoose";
import { auditPlugin } from "./utilities/auditPlugin.ts";

mongoose.plugin(auditPlugin);

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/jk_healthcare";

export const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    throw err;
  }
};

// Production/dev startup must not advertise a live HTTP process before MongoDB
// is available. Tests connect their own in-memory database before importing app.
if (process.env.NODE_ENV !== "test") {
  await connectDB();
}

export default mongoose;

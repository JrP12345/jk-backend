import mongoose from "mongoose";
import { auditPlugin } from "./utilities/auditPlugin.ts";

mongoose.plugin(auditPlugin);

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/jk_healthcare";

const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
};

if (process.env.NODE_ENV !== "test") {
  connectDB();
}

export default mongoose;
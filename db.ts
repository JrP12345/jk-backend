import mongoose from "mongoose";
import { auditPlugin } from "./utilities/auditPlugin.ts";

mongoose.plugin(auditPlugin);

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/jk_healthcare";

export const connectDB = async () => {
  try {
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE) || 25,
      minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE) || 5,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log("Connected to MongoDB with connection pool (min: 5, max: 25)");
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

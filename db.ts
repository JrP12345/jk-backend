import mongoose from "mongoose";
import { auditPlugin } from "./utilities/auditPlugin.ts";
import {
  DB_POOL_SIZE,
  DB_SOCKET_TIMEOUT_MS,
  DB_SERVER_SELECTION_TIMEOUT_MS,
} from "./utilities/scalability.ts";

mongoose.plugin(auditPlugin);

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/jk_healthcare";

export const connectDB = async () => {
  try {
    const maxPoolSize = Number(process.env.MONGODB_MAX_POOL_SIZE) || DB_POOL_SIZE;
    const minPoolSize = Number(process.env.MONGODB_MIN_POOL_SIZE) || (process.env.NODE_ENV === "production" ? 10 : 2);
    await mongoose.connect(MONGODB_URI, {
      maxPoolSize,
      minPoolSize,
      serverSelectionTimeoutMS: DB_SERVER_SELECTION_TIMEOUT_MS,
      socketTimeoutMS: DB_SOCKET_TIMEOUT_MS,
    });
    console.log(`Connected to MongoDB with connection pool (min: ${minPoolSize}, max: ${maxPoolSize})`);
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

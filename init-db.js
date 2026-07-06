import mongoose from "mongoose";
import "./db.ts";

async function initializeDB() {
  try {
    console.log("Connecting to database and dropping existing database for a clean start...");
    
    if (mongoose.connection.db) {
      await mongoose.connection.db.dropDatabase();
      console.log("✅ Database dropped successfully.");
    } else {
      // Wait briefly if connection is not fully ready
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (mongoose.connection.db) {
        await mongoose.connection.db.dropDatabase();
        console.log("✅ Database dropped successfully.");
      } else {
        console.log("⚠️ Could not drop database: connection not ready.");
      }
    }
  } catch (err) {
    console.error("❌ Failed to initialize database:", err);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
}

// Wait for connection to open before dropping
if (mongoose.connection.readyState === 1) {
  initializeDB();
} else {
  mongoose.connection.once("open", () => {
    initializeDB();
  });
}

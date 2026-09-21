import mongoose from "mongoose";
import { NotificationDelivery } from "../models/NotificationDelivery.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { WorkerLease } from "../models/WorkerLease.ts";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }

  await mongoose.connect(uri);
  await NotificationDelivery.createIndexes();
  await OutboundMessage.createIndexes();
  await WorkerLease.createIndexes();
  console.log("Outbox and worker-lease indexes are ready.");
}

main()
  .catch((err) => {
    console.error("Failed to prepare outbox indexes:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });

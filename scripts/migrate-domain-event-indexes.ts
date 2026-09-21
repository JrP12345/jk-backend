import mongoose from "mongoose";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }

  await mongoose.connect(uri);
  await DomainEventOutbox.createIndexes();
  console.log("Domain event outbox indexes are ready.");
}

main()
  .catch((err) => {
    console.error("Failed to prepare domain event outbox indexes:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });

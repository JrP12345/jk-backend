import { verifyEnv } from "../utilities/config.ts";
import { notificationDeliveryWorker } from "../notifications/workers/NotificationDeliveryWorker.ts";

verifyEnv();
await import("../db.ts");
notificationDeliveryWorker.start();
console.log("Notification delivery worker started");

const shutdown = async () => {
  await notificationDeliveryWorker.stop();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

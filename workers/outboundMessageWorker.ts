import { verifyEnv } from "../utilities/config.ts";
import { outboundMessageDeliveryWorker } from "../services/OutboundMessageDeliveryWorker.ts";
import { whatsAppWebhookWorker } from "../services/WhatsAppWebhookService.ts";

verifyEnv();
await import("../db.ts");
outboundMessageDeliveryWorker.start();
whatsAppWebhookWorker.start();
console.log("Outbound message worker started");

const shutdown = async () => {
  await outboundMessageDeliveryWorker.stop();
  await whatsAppWebhookWorker.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

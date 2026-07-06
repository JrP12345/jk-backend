import { requestContextStore } from "./context.ts";
import { AuditLog } from "../models/AuditLog.ts";

export function auditPlugin(schema: any) {
  schema.post("save", async function(doc: any) {
    if (doc.constructor.modelName === "AuditLog") return;

    const context = requestContextStore.getStore();
    const userId = context?.userId;

    // Only create log if there is an authenticated user context (prevents noise from unauthenticated ops, or allows system seeding if we specify)
    if (!userId) return;

    try {
      await AuditLog.create({
        userId,
        action: `${doc.constructor.modelName.toUpperCase()}_SAVE`,
        targetId: doc._id,
        targetModel: doc.constructor.modelName,
        details: doc.toJSON()
      });
    } catch (err) {
      console.error("Audit log creation failed inside plugin:", err);
    }
  });
}

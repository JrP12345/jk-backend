import { requestContextStore } from "./context.ts";
import { AuditLog } from "../models/AuditLog.ts";

export function auditPlugin(schema: any) {
  schema.post("save", async function(this: any, doc: any) {
    if (!doc.constructor?.modelName || doc.constructor.modelName === "AuditLog") return;

    const context = requestContextStore.getStore();
    const userId = context?.userId;
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
      console.error("Audit log creation failed inside plugin (save):", err);
    }
  });

  schema.post("findOneAndUpdate", async function(this: any, res: any) {
    if (!res || !this.model || this.model.modelName === "AuditLog") return;

    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;

    try {
      await AuditLog.create({
        userId,
        action: `${this.model.modelName.toUpperCase()}_UPDATE`,
        targetId: res._id,
        targetModel: this.model.modelName,
        details: typeof res.toJSON === "function" ? res.toJSON() : res
      });
    } catch (err) {
      console.error("Audit log creation failed inside plugin (findOneAndUpdate):", err);
    }
  });

  schema.post("findOneAndDelete", async function(this: any, res: any) {
    if (!res || !this.model || this.model.modelName === "AuditLog") return;

    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;

    try {
      await AuditLog.create({
        userId,
        action: `${this.model.modelName.toUpperCase()}_DELETE`,
        targetId: res._id,
        targetModel: this.model.modelName,
        details: { id: res._id.toString() }
      });
    } catch (err) {
      console.error("Audit log creation failed inside plugin (findOneAndDelete):", err);
    }
  });
}


import { requestContextStore } from "./context.ts";
import { AuditLog } from "../models/AuditLog.ts";

export function auditPlugin(schema: any) {
  schema.post("save", async function(this: any, doc: any) {
    if (!doc.constructor?.modelName || ["AuditLog", "AuditChainHead", "OperationReceipt"].includes(doc.constructor.modelName)) return;

    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;

    try {
      await AuditLog.create({
        userId,
        organizationId: context?.organizationId || undefined,
        action: `${doc.constructor.modelName.toUpperCase()}_SAVE`,
        targetId: doc._id,
        targetModel: doc.constructor.modelName,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        category: "CLINICAL_WRITE",
        details: doc.toJSON()
      }, { session: doc.$session?.() || undefined });
    } catch (err) {
      throw err;
    }
  });

  schema.post("findOneAndUpdate", async function(this: any, res: any) {
    if (!res || !this.model || ["AuditLog", "AuditChainHead", "OperationReceipt"].includes(this.model.modelName)) return;

    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;

    try {
      await AuditLog.create({
        userId,
        organizationId: context?.organizationId || undefined,
        action: `${this.model.modelName.toUpperCase()}_UPDATE`,
        targetId: res._id,
        targetModel: this.model.modelName,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        category: "CLINICAL_WRITE",
        details: typeof res.toJSON === "function" ? res.toJSON() : res
      }, { session: this.getOptions?.().session });
    } catch (err) {
      throw err;
    }
  });

  schema.post("findOneAndDelete", async function(this: any, res: any) {
    if (!res || !this.model || ["AuditLog", "AuditChainHead", "OperationReceipt"].includes(this.model.modelName)) return;

    const context = requestContextStore.getStore();
    const userId = context?.userId;
    if (!userId) return;

    try {
      await AuditLog.create({
        userId,
        organizationId: context?.organizationId || undefined,
        action: `${this.model.modelName.toUpperCase()}_DELETE`,
        targetId: res._id,
        targetModel: this.model.modelName,
        ipAddress: context?.ipAddress,
        userAgent: context?.userAgent,
        category: "CLINICAL_WRITE",
        details: { id: res._id.toString() }
      }, { session: this.getOptions?.().session });
    } catch (err) {
      throw err;
    }
  });
}

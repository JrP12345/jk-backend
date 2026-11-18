import type { FastifyRequest, FastifyReply } from "fastify";
import mongoose from "mongoose";
import { actOnPurchaseOrder, listPurchaseOrders, purchaseOrderHistory, readPurchaseOrder, recoverPurchaseOrder, savePurchaseOrder } from "../services/PharmacyPurchaseOrderService.ts";
import { CommandError } from "../services/CommandReceiptService.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
export function purchaseOrderController(kind: "list" | "read" | "save" | "action" | "history" | "recover") {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    try {
      const id = (req.params as { id?: string }).id;
      const result = kind === "list" ? await listPurchaseOrders(req) : kind === "recover" ? await recoverPurchaseOrder(req, (req.params as { key: string }).key) : kind === "read" ? await readPurchaseOrder(req, id!) : kind === "history" ? await purchaseOrderHistory(req, id!) : kind === "action" ? await actOnPurchaseOrder(req, id!) : await savePurchaseOrder(req, id);
      return reply.code(kind === "save" && !id ? 201 : 200).send(successResponse(result));
    } catch (error) {
      if (error instanceof CommandError) return reply.code(error.statusCode).send(errorResponse(error.message));
      if ((error as { code?: number })?.code === 11000) return reply.code(409).send(errorResponse("This order reference already exists; reopen the existing order"));
      if (error instanceof mongoose.Error.ValidationError) return reply.code(400).send(errorResponse("Invalid order fields"));
      req.log.error({ err: error }, "Purchase order failed");
      return reply.code(500).send(errorResponse("Order outcome could not be confirmed. Keep the same request reference and reload before creating another order."));
    }
  };
}

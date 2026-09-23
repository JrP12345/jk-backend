import type { FastifyInstance } from "fastify";
import { authenticate, requirePlatformRoot } from "../middleware/auth.ts";
import {
  DEAD_LETTER_KINDS,
  listDeadLetters,
  replayDeadLetter,
  type DeadLetterKind,
} from "../services/deadLetterReplay.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";

export default async function outboxOperationsRoutes(app: FastifyInstance) {
  const rootOnly = { preHandler: [authenticate, requirePlatformRoot()] };

  app.get("/api/admin/operations/domain-events/metrics", rootOnly, async (_req, reply) => {
    try {
      const metrics = await domainEventDeliveryWorker.getMetrics();
      return reply.send({ success: true, data: metrics });
    } catch (err: any) {
      return reply.code(500).send({ success: false, message: err?.message || "Failed to retrieve domain event metrics" });
    }
  });

  app.get("/api/admin/operations/dead-letters", rootOnly, async (req, reply) => {
    const { kind = "notification_delivery", limit } = req.query as { kind?: string; limit?: string };
    if (!DEAD_LETTER_KINDS.includes(kind as DeadLetterKind)) {
      return reply.code(400).send({ success: false, message: "Unsupported dead-letter kind" });
    }

    const parsedLimit = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return reply.code(400).send({ success: false, message: "limit must be an integer between 1 and 100" });
    }

    return reply.send({
      success: true,
      data: await listDeadLetters(kind as DeadLetterKind, parsedLimit),
    });
  });

  app.post("/api/admin/operations/dead-letters/:kind/:id/replay", rootOnly, async (req, reply) => {
    const { kind, id } = req.params as { kind: string; id: string };
    const { confirmation } = (req.body as { confirmation?: string }) || {};
    if (!DEAD_LETTER_KINDS.includes(kind as DeadLetterKind)) {
      return reply.code(400).send({ success: false, message: "Unsupported dead-letter kind" });
    }
    if (confirmation !== "REPLAY") {
      return reply.code(400).send({ success: false, message: "Set confirmation to REPLAY to requeue a failed delivery" });
    }

    try {
      const result = await replayDeadLetter(kind as DeadLetterKind, id, req.user!.id);
      if (result.state !== "replayed") {
        if (result.state === "not_found") {
          return reply.code(404).send({ success: false, message: "Dead-letter record not found" });
        }
        return reply.code(409).send({ success: false, message: "Dead-letter record is not eligible for replay" });
      }
      return reply.send({ success: true, message: "Dead-letter delivery requeued", data: result.item });
    } catch (error: any) {
      return reply.code(400).send({ success: false, message: error?.message || "Unable to replay dead-letter delivery" });
    }
  });
}

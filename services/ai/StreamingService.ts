import type { FastifyReply } from "fastify";
import type { AIStreamChunk } from "./AIProvider.ts";

export class StreamingService {
  /**
   * Configures Fastify response headers for chunked Server-Sent Events (SSE) streaming.
   */
  static initSSEResponse(reply: FastifyReply) {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("X-Accel-Buffering", "no");
    reply.raw.statusCode = 200;
  }

  /**
   * Sends an SSE token chunk payload to the client.
   */
  static sendChunk(reply: FastifyReply, chunk: AIStreamChunk) {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
  }

  /**
   * Finalizes and closes the SSE stream.
   */
  static endStream(reply: FastifyReply, correlationId: string) {
    if (!reply.raw.writableEnded) {
      const finalChunk: AIStreamChunk = {
        correlationId,
        chunkIndex: -1,
        text: "",
        isComplete: true
      };
      reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      reply.raw.end();
    }
  }
}

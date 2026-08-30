import type { FastifyRequest, FastifyReply } from "fastify";
import { redisClient } from "../utilities/redis.ts";
import { Redis } from "ioredis";

export interface RealtimeMessage {
  type: "NOTIFICATION_RECEIVED" | "UNREAD_COUNT_UPDATED";
  data: any;
}

// Memory map of active SSE connection streams per user ID
const sseStreamsMap = new Map<string, Set<FastifyReply>>();

/**
 * Total active SSE stream connections helper
 */
export function getActiveSseConnectionsCount(): number {
  let count = 0;
  sseStreamsMap.forEach((streams) => {
    count += streams.size;
  });
  return count;
}

/**
 * Register an active SSE response stream for a target user
 */
export function registerUserSseStream(userId: string, reply: FastifyReply) {
  if (!sseStreamsMap.has(userId)) {
    sseStreamsMap.set(userId, new Set());
  }
  sseStreamsMap.get(userId)!.add(reply);

  reply.raw.on("close", () => {
    const streams = sseStreamsMap.get(userId);
    if (streams) {
      streams.delete(reply);
      if (streams.size === 0) {
        sseStreamsMap.delete(userId);
      }
    }
  });
}

/**
 * Dispatch real-time notification to local active streams
 */
export function sendToUserLocally(userId: string, payload: RealtimeMessage) {
  const streams = sseStreamsMap.get(userId);
  if (streams && streams.size > 0) {
    const dataString = `data: ${JSON.stringify(payload)}\n\n`;
    streams.forEach((reply) => {
      try {
        if (!reply.raw.writableEnded) {
          reply.raw.write(dataString);
        }
      } catch (err) {
        console.error(`[SSE Stream Error] Failed writing to user ${userId} stream:`, err);
      }
    });
  }
}

// ─── Redis Subscriber for Multi-Node Backend Cluster Scaling ─────────
let redisSubscriber: Redis | null = null;
if (redisClient) {
  try {
    redisSubscriber = redisClient.duplicate();
    redisSubscriber.on("error", (err: Error) => {
      // Suppress unhandled EventEmitter crash if redis drops
    });

    redisSubscriber.psubscribe("user_notifications:*", (err) => {
      if (err) {
        console.warn("[Redis Subscriber Warning] Failed psubscribe to user_notifications:*", err);
      } else {
        console.log("[Redis Cluster Listener] Subscribed to multi-instance user notification events.");
      }
    });

    redisSubscriber.on("pmessage", (_pattern, channel, message) => {
      try {
        const userId = channel.replace("user_notifications:", "");
        const payload: RealtimeMessage = JSON.parse(message);
        sendToUserLocally(userId, payload);
      } catch (err) {
        console.error("[Redis Cluster Listener Error] Failed parsing Redis PubSub message:", err);
      }
    });
  } catch (err: any) {
    console.warn("[Redis Subscriber Error] Failed to initialize subscriber:", err.message);
  }
}

/**
 * Global Real-time Dispatcher (Cluster-aware with Redis Pub/Sub)
 */
export function broadcastRealtimeNotification(userId: string, payload: RealtimeMessage) {
  // 1. Deliver to local connected HTTP streams on this node
  sendToUserLocally(userId, payload);

  // 2. Publish to Redis for other multi-instance backend nodes
  if (redisClient) {
    try {
      redisClient.publish(`user_notifications:${userId}`, JSON.stringify(payload)).catch((err) => {
        console.warn("[Redis PubSub Warning] Failed to publish notification to Redis:", err?.message || err);
      });
    } catch (err: any) {
      console.warn("[Redis PubSub Warning] Failed to publish notification to Redis:", err?.message || err);
    }
  }
}

/**
 * SSE Stream Route Handler with 15-Second Keep-Alive Heartbeat
 */
export async function notificationStreamHandler(req: FastifyRequest, reply: FastifyReply) {
  const userId = req.user?.id;
  if (!userId) {
    return reply.code(401).send({ success: false, message: "Unauthorized" });
  }

  const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean)
    : ["http://localhost:3000"];
  const requestOrigin = req.headers.origin as string | undefined;
  const validOrigin = requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": validOrigin,
    "Access-Control-Allow-Credentials": "true",
  });

  // Initial connection message
  reply.raw.write(`data: ${JSON.stringify({ type: "CONNECTED", message: "Notification stream established" })}\n\n`);

  registerUserSseStream(userId, reply);

  // 15-Second Keep-Alive Heartbeat Timer to prevent Cloudflare / ALB / Nginx proxy timeouts
  const heartbeatTimer = setInterval(() => {
    try {
      if (!reply.raw.writableEnded) {
        reply.raw.write(": keep-alive\n\n");
      } else {
        clearInterval(heartbeatTimer);
      }
    } catch (err) {
      clearInterval(heartbeatTimer);
    }
  }, 15000);

  // Connection close cleanup
  req.raw.on("close", () => {
    clearInterval(heartbeatTimer);
    reply.raw.end();
  });
}

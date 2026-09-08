import type { FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import crypto from "node:crypto";
import { redisClient } from "../utilities/redis.ts";
import { Redis } from "ioredis";
import { verifyAccessToken } from "../utilities/helpers.ts";

export interface RealtimeMessage {
  type: "NOTIFICATION_RECEIVED" | "UNREAD_COUNT_UPDATED" | "QUEUE_UPDATED" | "QUEUE_CALL_NEXT" | "DISRUPTION_TRIAGE_REQUIRED" | "QUEUE_EMERGENCY_STAT" | "PATIENT_RETURNED" | "LAB_RESULTS_READY" | "LAB_ORDER_PLACED" | "PAYMENT_RECEIVED" | "PRESCRIPTION_ISSUED" | "PRESCRIPTION_DISPENSED" | "CLINICAL_PANIC_ALERT" | "PATIENT_RECALLED_TO_CABIN" | "HEARTBEAT" | "CONNECTED" | "ERROR" | "PONG";
  data?: any;
  message?: string;
  timestamp?: string;
  topic?: string;
  transport?: string;
  replayed?: boolean;
}

export interface ClusterMessageEnvelope {
  originNodeId: string;
  timestamp: string;
  payload: RealtimeMessage;
}

/**
 * Unique Node/Pod identifier for this process instance.
 * Used to prevent self-echo when Redis PubSub broadcasts back to the publishing pod.
 */
export const NODE_ID: string = process.env.POD_NAME || process.env.HOSTNAME || `node-${crypto.randomUUID()}`;

// ─── Connection Registries (In-Memory per Node) ──────────────────────────
const sseStreamsMap = new Map<string, Set<FastifyReply>>();
const userWebSocketsMap = new Map<string, Set<WebSocket>>();
const clinicQueueWebSocketsMap = new Map<string, Set<WebSocket>>();
const clinicClinicalWebSocketsMap = new Map<string, Set<WebSocket>>();

/**
 * Total active connection stats
 */
export function getActiveConnectionsStats(): { sseCount: number; wsUserCount: number; wsQueueCount: number; wsClinicalCount: number } {
  let sseCount = 0;
  sseStreamsMap.forEach((streams) => { sseCount += streams.size; });

  let wsUserCount = 0;
  userWebSocketsMap.forEach((sockets) => { wsUserCount += sockets.size; });

  let wsQueueCount = 0;
  clinicQueueWebSocketsMap.forEach((sockets) => { wsQueueCount += sockets.size; });

  let wsClinicalCount = 0;
  clinicClinicalWebSocketsMap.forEach((sockets) => { wsClinicalCount += sockets.size; });

  return { sseCount, wsUserCount, wsQueueCount, wsClinicalCount };
}

export function getActiveSseConnectionsCount(): number {
  let count = 0;
  sseStreamsMap.forEach((streams) => { count += streams.size; });
  return count;
}

// ─── Critical Alert Replay Buffer (Patient Safety Guarantee) ─────────
// Plain Redis PubSub is fire-and-forget. For critical clinical panic alerts and emergency
// STAT triage, reconnecting clients or pods restarting during an alert must receive
// recent pending alerts rather than silently dropping them.
const ALERT_TIER_TYPES = new Set<string>([
  "CLINICAL_PANIC_ALERT",
  "QUEUE_EMERGENCY_STAT",
  "DISRUPTION_TRIAGE_REQUIRED",
  "PATIENT_RECALLED_TO_CABIN",
]);

const ALERT_BUFFER_TTL_SECONDS = 7200; // 2 hours
const MAX_BUFFERED_ALERTS = 25;

export async function bufferCriticalAlert(channelKey: string, payload: RealtimeMessage): Promise<void> {
  if (!redisClient || !ALERT_TIER_TYPES.has(payload.type)) return;

  try {
    const key = `healthos:alert_buffer:${channelKey}`;
    await redisClient.rpush(key, JSON.stringify(payload));
    await redisClient.ltrim(key, -MAX_BUFFERED_ALERTS, -1);
    await redisClient.expire(key, ALERT_BUFFER_TTL_SECONDS);
  } catch (err: any) {
    console.warn("[Redis Alert Buffer Warning] Failed to buffer critical alert:", err?.message || err);
  }
}

export async function getBufferedCriticalAlerts(channelKey: string): Promise<RealtimeMessage[]> {
  if (!redisClient) return [];

  try {
    const key = `healthos:alert_buffer:${channelKey}`;
    const rawItems = await redisClient.lrange(key, 0, -1);
    return rawItems
      .map((item) => {
        try {
          const parsed = JSON.parse(item);
          return { ...parsed, replayed: true };
        } catch {
          return null;
        }
      })
      .filter(Boolean) as RealtimeMessage[];
  } catch (err: any) {
    console.warn("[Redis Alert Buffer Warning] Failed to retrieve buffered alerts:", err?.message || err);
    return [];
  }
}

// ─── SSE Stream Registration ──────────────────────────────────────────
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

// ─── WebSocket Registration (User Notifications) ──────────────────────
export function registerUserWebSocket(userId: string, socket: WebSocket) {
  if (!userWebSocketsMap.has(userId)) {
    userWebSocketsMap.set(userId, new Set());
  }
  userWebSocketsMap.get(userId)!.add(socket);

  socket.on("close", () => {
    const sockets = userWebSocketsMap.get(userId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        userWebSocketsMap.delete(userId);
      }
    }
  });
}

// ─── WebSocket Registration (Clinic OPD Queue) ────────────────────────
export function registerClinicQueueWebSocket(clinicId: string, socket: WebSocket) {
  if (!clinicQueueWebSocketsMap.has(clinicId)) {
    clinicQueueWebSocketsMap.set(clinicId, new Set());
  }
  clinicQueueWebSocketsMap.get(clinicId)!.add(socket);

  socket.on("close", () => {
    const sockets = clinicQueueWebSocketsMap.get(clinicId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        clinicQueueWebSocketsMap.delete(clinicId);
      }
    }
  });
}

// ─── WebSocket Registration (Clinic Clinical Staff Displays) ──────────
export function registerClinicClinicalWebSocket(clinicId: string, socket: WebSocket) {
  if (!clinicClinicalWebSocketsMap.has(clinicId)) {
    clinicClinicalWebSocketsMap.set(clinicId, new Set());
  }
  clinicClinicalWebSocketsMap.get(clinicId)!.add(socket);

  socket.on("close", () => {
    const sockets = clinicClinicalWebSocketsMap.get(clinicId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        clinicClinicalWebSocketsMap.delete(clinicId);
      }
    }
  });
}

// ─── Local Dispatch Helpers ──────────────────────────────────────────
export function sendToUserLocally(userId: string, payload: RealtimeMessage) {
  // 1. Deliver to SSE streams
  const sseStreams = sseStreamsMap.get(userId);
  if (sseStreams && sseStreams.size > 0) {
    const dataString = `data: ${JSON.stringify(payload)}\n\n`;
    sseStreams.forEach((reply) => {
      try {
        if (!reply.raw.writableEnded) {
          reply.raw.write(dataString);
        }
      } catch (err) {
        console.error(`[SSE Stream Error] Failed writing to user ${userId} stream:`, err);
      }
    });
  }

  // 2. Deliver to WebSocket connections
  const webSockets = userWebSocketsMap.get(userId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(payload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(wsString);
        }
      } catch (err) {
        console.error(`[WebSocket Error] Failed writing to user ${userId} websocket:`, err);
      }
    });
  }
}

export function sendToClinicQueueLocally(clinicId: string, payload: RealtimeMessage) {
  const webSockets = clinicQueueWebSocketsMap.get(clinicId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(payload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(wsString);
        }
      } catch (err) {
        console.error(`[Queue WebSocket Error] Failed writing to clinic ${clinicId} queue websocket:`, err);
      }
    });
  }
}

export function sendToClinicClinicalLocally(clinicId: string, payload: RealtimeMessage) {
  const webSockets = clinicClinicalWebSocketsMap.get(clinicId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(payload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(wsString);
        }
      } catch (err) {
        console.error(`[Clinical WebSocket Error] Failed writing to clinic ${clinicId} clinical websocket:`, err);
      }
    });
  }
}

// ─── Redis Subscriber for Multi-Node Cluster Scaling ─────────────────
let redisSubscriber: Redis | null = null;

export function initRedisSubscriber() {
  if (!redisClient) return null;

  try {
    if (redisSubscriber) return redisSubscriber;

    redisSubscriber = redisClient.duplicate();
    redisSubscriber.on("error", (err: Error) => {
      console.warn("[Redis Subscriber Warning] Redis subscriber error:", err.message);
    });

    const subscribeChannels = () => {
      redisSubscriber!.psubscribe("user_notifications:*", "clinic_queue:*", "clinic_clinical:*", "clinic_broadcast:*", (err) => {
        if (err) {
          console.warn("[Redis Subscriber Warning] Failed psubscribe:", err);
        } else {
          console.log("[Redis Cluster Listener] Subscribed to multi-instance notification, queue, clinical & broadcast channels.");
        }
      });
    };

    redisSubscriber.on("ready", subscribeChannels);
    subscribeChannels();

    redisSubscriber.on("pmessage", (_pattern, channel, message) => {
      try {
        let envelope: ClusterMessageEnvelope;
        try {
          envelope = JSON.parse(message);
        } catch {
          return;
        }

        // Self-echo suppression: if this node originally published the message,
        // it was already delivered locally synchronously. Discard to prevent double delivery.
        if (envelope.originNodeId && envelope.originNodeId === NODE_ID) {
          return;
        }

        const payload: RealtimeMessage = envelope.payload || (envelope as any);

        if (channel.startsWith("user_notifications:")) {
          const userId = channel.replace("user_notifications:", "");
          sendToUserLocally(userId, payload);
        } else if (channel.startsWith("clinic_queue:")) {
          const clinicId = channel.replace("clinic_queue:", "");
          sendToClinicQueueLocally(clinicId, payload);
        } else if (channel.startsWith("clinic_clinical:")) {
          const clinicId = channel.replace("clinic_clinical:", "");
          sendToClinicClinicalLocally(clinicId, payload);
        } else if (channel.startsWith("clinic_broadcast:")) {
          const clinicId = channel.replace("clinic_broadcast:", "");
          sendToClinicClinicalLocally(clinicId, payload);
        }
      } catch (err) {
        console.error("[Redis Cluster Listener Error] Failed parsing PubSub message:", err);
      }
    });

    return redisSubscriber;
  } catch (err: any) {
    console.warn("[Redis Subscriber Error] Failed to initialize subscriber:", err.message);
    return null;
  }
}

initRedisSubscriber();

// ─── Global Broadcast (Local Node + Redis Cluster Fan-Out) ───────────

export function broadcastRealtimeNotification(userId: string, payload: RealtimeMessage) {
  // 1. Deliver synchronously to local node clients
  sendToUserLocally(userId, payload);

  // 2. Buffer if critical alert
  bufferCriticalAlert(`user:${userId}`, payload);

  // 3. Publish to cluster with originNodeId envelope to prevent self-echo
  if (redisClient) {
    const envelope: ClusterMessageEnvelope = {
      originNodeId: NODE_ID,
      timestamp: new Date().toISOString(),
      payload,
    };
    redisClient.publish(`user_notifications:${userId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish notification to Redis:", err?.message || err);
    });
  }
}

/**
 * Sanitizes messages destined for public waiting-room TV displays.
 * Strips all diagnostic test names, quantitative lab values, clinical reasons, and PHI.
 */
export function sanitizeLobbyQueueMessage(payload: RealtimeMessage): RealtimeMessage {
  // If payload is a clinical panic alert or lab result, suppress clinical data completely
  if (payload.type === "CLINICAL_PANIC_ALERT" || payload.type === "LAB_RESULTS_READY") {
    const canaryData = payload.data?.isCanary ? { isCanary: true, canaryToken: payload.data?.canaryToken } : {};
    return {
      type: "QUEUE_UPDATED",
      data: {
        appointmentId: payload.data?.appointmentId,
        tokenNumber: payload.data?.tokenNumber,
        status: "QUEUE_UPDATED",
        ...canaryData,
      },
      message: payload.data?.tokenNumber ? `Status updated for Token #${payload.data.tokenNumber}` : "Queue updated",
      timestamp: payload.timestamp || new Date().toISOString(),
      topic: payload.topic,
      transport: payload.transport,
    };
  }

  // If payload data has sensitive diagnostic properties, strip them
  if (payload.data && typeof payload.data === "object") {
    const { testName, resultValue, panicReason, referenceRange, isAbnormal, isPanic, ...safeData } = payload.data;
    return {
      ...payload,
      data: safeData,
    };
  }

  return payload;
}

export function broadcastQueueUpdate(clinicId: string, rawPayload: RealtimeMessage) {
  const payload = sanitizeLobbyQueueMessage(rawPayload);

  // 1. Deliver synchronously to local clinic sockets
  sendToClinicQueueLocally(clinicId, payload);

  // 2. Buffer if critical alert (e.g. STAT or panic alerts)
  bufferCriticalAlert(`clinic:${clinicId}`, payload);

  // 3. Publish to cluster with originNodeId envelope
  if (redisClient) {
    const envelope: ClusterMessageEnvelope = {
      originNodeId: NODE_ID,
      timestamp: new Date().toISOString(),
      payload,
    };
    redisClient.publish(`clinic_queue:${clinicId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish queue event to Redis:", err?.message || err);
    });
  }
}

/**
 * Broadcast clinical events (panic alerts, critical lab results) to authenticated clinical staff channels.
 */
export function broadcastClinicalRealtime(clinicId: string, payload: RealtimeMessage) {
  sendToClinicClinicalLocally(clinicId, payload);
  bufferCriticalAlert(`clinic_clinical:${clinicId}`, payload);

  if (redisClient) {
    const envelope: ClusterMessageEnvelope = {
      originNodeId: NODE_ID,
      timestamp: new Date().toISOString(),
      payload,
    };
    redisClient.publish(`clinic_clinical:${clinicId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish clinical broadcast to Redis:", err?.message || err);
    });
  }
}

/**
 * Backwards-compatible alias for clinic-wide broadcast
 */
export function broadcastClinicRealtime(clinicId: string, payload: RealtimeMessage) {
  broadcastClinicalRealtime(clinicId, payload);
}

// ─── Native WebSocket Connection Handlers ─────────────────────────────

/**
 * Extract auth user from WebSocket request (cookies, headers, or ?token= query parameter)
 */
export function resolveWebSocketAuth(req: FastifyRequest): { id: string; role?: string; organization_id?: string } | null {
  let token = (req.query as any)?.token || req.cookies?.access_token || (req.headers.authorization?.replace(/^Bearer\s+/i, ""));

  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)access_token=([^;]+)/);
    if (match) {
      token = decodeURIComponent(match[1]);
    }
  }

  if (!token) return null;

  try {
    const payload = verifyAccessToken(token);
    if (payload?.id) {
      return { id: payload.id, role: payload.role, organization_id: payload.organization_id };
    }
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * Fastify WebSocket handler for User Notifications (/api/ws & /api/notifications/ws)
 */
export function handleNotificationWebSocket(socket: WebSocket, req: FastifyRequest) {
  const user = resolveWebSocketAuth(req);
  if (!user) {
    socket.send(JSON.stringify({ type: "ERROR", message: "Unauthorized: Valid authentication token required" }));
    socket.close(1008, "Unauthorized");
    return;
  }

  registerUserWebSocket(user.id, socket);

  socket.send(JSON.stringify({
    type: "CONNECTED",
    transport: "websocket",
    message: `Realtime WebSocket stream established for user ${user.id}`,
    timestamp: new Date().toISOString()
  }));

  // Replay unacknowledged recent critical alerts (prevents missed panic alerts during pod restarts/reconnects)
  getBufferedCriticalAlerts(`user:${user.id}`).then((buffered) => {
    buffered.forEach((alert) => {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(alert));
        }
      } catch {
        // Safe ignore
      }
    });
  });

  // Ping-pong keepalive interval
  const pingInterval = setInterval(() => {
    if (socket.readyState === 1 /* OPEN */) {
      try {
        socket.ping();
      } catch {
        clearInterval(pingInterval);
      }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  socket.on("message", (raw: any) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "PING") {
        socket.send(JSON.stringify({ type: "PONG", timestamp: new Date().toISOString() }));
      }
    } catch {
      // Ignore unparseable client messages
    }
  });

  socket.on("close", () => {
    clearInterval(pingInterval);
  });
}

/**
 * Fastify WebSocket handler for Clinic OPD Queue Displays (/api/queue/ws)
 */
export function handleQueueWebSocket(socket: WebSocket, req: FastifyRequest) {
  const clinicId = (req.query as any)?.clinicId;
  if (!clinicId || typeof clinicId !== "string" || clinicId.length !== 24) {
    socket.send(JSON.stringify({ type: "ERROR", message: "Valid 24-character clinicId query parameter required" }));
    socket.close(1008, "Invalid clinicId");
    return;
  }

  registerClinicQueueWebSocket(clinicId, socket);

  socket.send(JSON.stringify({
    type: "CONNECTED",
    transport: "websocket",
    topic: `clinic_queue:${clinicId}`,
    message: `Subscribed to real-time OPD Queue updates for clinic ${clinicId}`,
    timestamp: new Date().toISOString()
  }));

  // Replay unacknowledged recent critical alerts for this clinic queue/display
  getBufferedCriticalAlerts(`clinic:${clinicId}`).then((buffered) => {
    buffered.forEach((alert) => {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(alert));
        }
      } catch {
        // Safe ignore
      }
    });
  });

  const pingInterval = setInterval(() => {
    if (socket.readyState === 1) {
      try { socket.ping(); } catch { clearInterval(pingInterval); }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  socket.on("message", (raw: any) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "PING") {
        socket.send(JSON.stringify({ type: "PONG", timestamp: new Date().toISOString() }));
      }
    } catch {
      // ignore
    }
  });

  socket.on("close", () => {
    clearInterval(pingInterval);
  });
}

const CLINICAL_STAFF_ROLES = new Set([
  "doctor",
  "nurse",
  "receptionist",
  "pharmacist",
  "lab_technician",
  "admin",
  "org_admin",
  "root",
]);

/**
 * Fastify WebSocket handler for Authenticated Clinical Staff Displays (/api/clinical/ws)
 */
export function handleClinicalWebSocket(socket: WebSocket, req: FastifyRequest) {
  const user = resolveWebSocketAuth(req);
  if (!user) {
    socket.send(JSON.stringify({ type: "ERROR", message: "Unauthorized: Valid authentication token required" }));
    socket.close(1008, "Unauthorized");
    return;
  }

  if (!user.role || !CLINICAL_STAFF_ROLES.has(user.role)) {
    socket.send(JSON.stringify({ type: "ERROR", message: "Forbidden: Clinical staff role required for clinical channel" }));
    socket.close(1008, "Forbidden");
    return;
  }

  const clinicId = (req.query as any)?.clinicId;
  if (!clinicId || typeof clinicId !== "string" || clinicId.length !== 24) {
    socket.send(JSON.stringify({ type: "ERROR", message: "Valid 24-character clinicId query parameter required" }));
    socket.close(1008, "Invalid clinicId");
    return;
  }

  registerClinicClinicalWebSocket(clinicId, socket);

  socket.send(JSON.stringify({
    type: "CONNECTED",
    transport: "websocket",
    topic: `clinic_clinical:${clinicId}`,
    message: `Subscribed to real-time clinical alerts for clinic ${clinicId}`,
    timestamp: new Date().toISOString()
  }));

  // Replay unacknowledged recent critical alerts for this clinical station
  getBufferedCriticalAlerts(`clinic_clinical:${clinicId}`).then((buffered) => {
    buffered.forEach((alert) => {
      try {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify(alert));
        }
      } catch {
        // Safe ignore
      }
    });
  });

  const pingInterval = setInterval(() => {
    if (socket.readyState === 1) {
      try { socket.ping(); } catch { clearInterval(pingInterval); }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  socket.on("message", (raw: any) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "PING") {
        socket.send(JSON.stringify({ type: "PONG", timestamp: new Date().toISOString() }));
      }
    } catch {
      // ignore
    }
  });

  socket.on("close", () => {
    clearInterval(pingInterval);
  });
}

// ─── SSE Stream Handler (Backwards-Compatible Fallback) ────────────────
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
  reply.raw.write(`data: ${JSON.stringify({ type: "CONNECTED", transport: "sse", message: "Notification stream established" })}\n\n`);

  registerUserSseStream(userId, reply);

  // 15-Second Keep-Alive Heartbeat Timer
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

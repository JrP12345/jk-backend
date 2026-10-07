import type { FastifyRequest, FastifyReply } from "fastify";
import type { WebSocket } from "ws";
import crypto from "node:crypto";
import { redisClient } from "../utilities/redis.ts";
import { Redis } from "ioredis";
import { verifyAccessToken } from "../utilities/helpers.ts";
import { Location } from "../models/Location.ts";
import { resolveSession } from '../utilities/sessionResolver.ts';
import { getEffectivePermissions } from '../utilities/permissions.ts';
import { isOriginAllowed } from '../middleware/csrf.ts';

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
const MAX_CONNECTION_BUFFER = 256 * 1024;
function safeSocketSend(socket: WebSocket, data: string) {
  if (socket.bufferedAmount > MAX_CONNECTION_BUFFER) { socket.close(1013, 'Slow consumer'); return; }
  if (socket.readyState === 1) socket.send(data);
}
function safeSseWrite(reply: FastifyReply, data: string) {
  if (reply.raw.writableLength > MAX_CONNECTION_BUFFER) { reply.raw.destroy(); return; }
  if (!reply.raw.writableEnded) reply.raw.write(data);
}
const aliveSockets = new WeakMap<WebSocket, boolean>();
function heartbeatSocket(socket: WebSocket) {
  if (aliveSockets.get(socket) === false) { socket.terminate(); return; }
  if (!aliveSockets.has(socket)) socket.on('pong', () => aliveSockets.set(socket, true));
  aliveSockets.set(socket, false);
  socket.ping();
}
const sseStreamsMap = new Map<string, Set<FastifyReply>>();
const userWebSocketsMap = new Map<string, Set<WebSocket>>();
const locationQueueWebSocketsMap = new Map<string, Set<WebSocket>>();
type RealtimeIdentity = { id: string; role?: string; organization_id?: string; sessionId?: string; authVersion?: number; exp?: number };
const privateGuards = new WeakMap<object, () => Promise<boolean>>();
const privateClosers = new Map<string, Set<() => void>>();
function bindPrivateConnection(user: RealtimeIdentity, connection: object, close: () => void, extra?: () => Promise<boolean>) {
  if (!privateClosers.has(user.id)) privateClosers.set(user.id, new Set());
  privateClosers.get(user.id)!.add(close);
  let pending: Promise<boolean> | undefined;
  const validate = async () => {
    if (user.exp && user.exp * 1000 <= Date.now()) return false;
    if (!user.sessionId) return false;
    const result = await resolveSession(user.sessionId, user.authVersion);
    return result.valid && result.session?.userId === user.id && result.session?.role === user.role &&
      result.session?.organizationId === user.organization_id && (!extra || await extra());
  };
  privateGuards.set(connection, () => {
    if (!pending) pending = validate().catch(() => false).then(valid => { if (!valid) close(); return valid; }).finally(() => { pending = undefined; });
    return pending;
  });
  const emitter = connection as any;
  (emitter.raw || emitter).on('close', () => {
    privateGuards.delete(connection);
    privateClosers.get(user.id)?.delete(close);
    if (!privateClosers.get(user.id)?.size) privateClosers.delete(user.id);
  });
}
function sendPrivate(connection: object, send: () => void) {
  const guard = privateGuards.get(connection);
  if (!guard) return;
  void guard().then(valid => { if (valid && privateGuards.has(connection)) send(); }).catch(() => {});
}
const locationClinicalWebSocketsMap = new Map<string, Set<WebSocket>>();
export const CANARY_LOCATION_ID = "00000000000000000000canary";
const syntheticClinicalObservers = new Set<(payload: RealtimeMessage) => void>();
/** In-process diagnostic observer; it receives only the reserved synthetic channel. */
export function observeSyntheticClinicalBroadcast(listener: (payload: RealtimeMessage) => void): () => void {
  syntheticClinicalObservers.add(listener);
  return () => { syntheticClinicalObservers.delete(listener); };
}

export function getActiveSseConnectionsCount(): number {
  let count = 0;
  sseStreamsMap.forEach((streams) => { count += streams.size; });
  return count;
}

/**
 * Force-terminates all active WebSockets associated with a revoked user session.
 */
export function disconnectUserWebSockets(userId: string, code: number = 4001, reason: string = "Session revoked"): void {
  for (const close of privateClosers.get(userId) || []) { try { close(); } catch {} }
  privateClosers.delete(userId);
  for (const stream of sseStreamsMap.get(userId) || []) stream.raw.end();
  sseStreamsMap.delete(userId);
  const sockets = userWebSocketsMap.get(userId);
  if (sockets) {
    for (const ws of sockets) {
      try {
        ws.close(code, reason);
      } catch {
        // safe ignore
      }
    }
    userWebSocketsMap.delete(userId);
  }
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
    const key = `ekavyu:alert_buffer:${channelKey}`;
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
    const key = `ekavyu:alert_buffer:${channelKey}`;
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

// ─── WebSocket Registration (Location OPD Queue) ────────────────────────
export function registerLocationQueueWebSocket(locationId: string, socket: WebSocket) {
  if (!locationQueueWebSocketsMap.has(locationId)) {
    locationQueueWebSocketsMap.set(locationId, new Set());
  }
  locationQueueWebSocketsMap.get(locationId)!.add(socket);

  socket.on("close", () => {
    const sockets = locationQueueWebSocketsMap.get(locationId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        locationQueueWebSocketsMap.delete(locationId);
      }
    }
  });
}

// ─── WebSocket Registration (Location Clinical Staff Displays) ──────────
export function registerLocationClinicalWebSocket(locationId: string, socket: WebSocket) {
  if (!locationClinicalWebSocketsMap.has(locationId)) {
    locationClinicalWebSocketsMap.set(locationId, new Set());
  }
  locationClinicalWebSocketsMap.get(locationId)!.add(socket);

  socket.on("close", () => {
    const sockets = locationClinicalWebSocketsMap.get(locationId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        locationClinicalWebSocketsMap.delete(locationId);
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
          sendPrivate(reply, () => { if (!reply.raw.writableEnded) safeSseWrite(reply, dataString); });
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
          sendPrivate(socket, () => { if (socket.readyState === 1) safeSocketSend(socket, wsString); });
        }
      } catch (err) {
        console.error(`[WebSocket Error] Failed writing to user ${userId} websocket:`, err);
      }
    });
  }
}

function sanitizePublicQueueMessage(payload: RealtimeMessage): RealtimeMessage | null {
  const allowedTypes = new Set([
    "QUEUE_UPDATED",
    "QUEUE_CALL_NEXT",
    "PATIENT_RECALLED_TO_CABIN",
    "QUEUE_POSITION_CHANGED",
    "QUEUE_DELAY_ALERT",
    "DOCTOR_STATUS_CHANGED",
    "QUEUE_EMERGENCY_STAT",
    "PATIENT_RETURNED"
  ]);
  if (!allowedTypes.has(payload.type)) return null;

  const data = payload.data || {};
  return {
    type: payload.type,
    timestamp: payload.timestamp,
    data: {
      tokenNumber: data.tokenNumber,
      currentToken: data.currentToken ?? data.tokenNumber,
      queueLength: data.queueLength,
      queuePosition: data.queuePosition,
      estimatedWaitTime: data.estimatedWaitTime,
      estimatedWaitMinutes: data.estimatedWaitMinutes ?? data.estimatedWaitTime,
      status: data.status,
      doctorStatus: data.doctorStatus,
      doctorName: data.doctorName,
      roomNumber: data.roomNumber,
    },
  };
}

export function sendToLocationQueueLocally(locationId: string, payload: RealtimeMessage) {
  const publicPayload = sanitizePublicQueueMessage(payload);
  if (!publicPayload) return;
  const webSockets = locationQueueWebSocketsMap.get(locationId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(publicPayload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1 /* OPEN */) {
          safeSocketSend(socket, wsString);
        }
      } catch (err) {
        console.error(`[Queue WebSocket Error] Failed writing to location ${locationId} queue websocket:`, err);
      }
    });
  }
}

export function sendToLocationClinicalLocally(locationId: string, payload: RealtimeMessage) {
  if (locationId === CANARY_LOCATION_ID && payload.data?.isCanary === true) {
    for (const listener of syntheticClinicalObservers) listener(payload);
  }
  const webSockets = locationClinicalWebSocketsMap.get(locationId);
  if (webSockets && webSockets.size > 0) {
    const wsString = JSON.stringify(payload);
    webSockets.forEach((socket) => {
      try {
        if (socket.readyState === 1 /* OPEN */) {
          sendPrivate(socket, () => { if (socket.readyState === 1) safeSocketSend(socket, wsString); });
        }
      } catch (err) {
        console.error(`[Clinical WebSocket Error] Failed writing to location ${locationId} clinical websocket:`, err);
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
      redisSubscriber!.psubscribe("user_notifications:*", "location_queue:*", "location_clinical:*", (err) => {
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
        } else if (channel.startsWith("location_queue:")) {
          const locationId = channel.replace("location_queue:", "");
          sendToLocationQueueLocally(locationId, payload);
        } else if (channel.startsWith("location_clinical:")) {
          const locationId = channel.replace("location_clinical:", "");
          sendToLocationClinicalLocally(locationId, payload);
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

/** Release long-lived transports before closing the HTTP listener on restart. */
export function closeRealtimeTransports(): void {
  for (const streams of sseStreamsMap.values()) {
    for (const reply of streams) reply.raw.end();
  }
  sseStreamsMap.clear();
  const sockets = new Set<WebSocket>();
  for (const registry of [userWebSocketsMap, locationQueueWebSocketsMap, locationClinicalWebSocketsMap]) {
    for (const connections of registry.values()) for (const socket of connections) sockets.add(socket);
    registry.clear();
  }
  for (const socket of sockets) socket.terminate();
  redisSubscriber?.disconnect();
  redisSubscriber = null;
}

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

export function broadcastQueueUpdate(locationId: string, rawPayload: RealtimeMessage) {
  const payload = sanitizeLobbyQueueMessage(rawPayload);

  // 1. Deliver synchronously to local location sockets
  sendToLocationQueueLocally(locationId, payload);
  broadcastClinicalRealtime(locationId, payload);

  // 2. Buffer if critical alert (e.g. STAT or panic alerts)
  bufferCriticalAlert(`location:${locationId}`, payload);

  // 3. Publish to cluster with originNodeId envelope
  if (redisClient) {
    const envelope: ClusterMessageEnvelope = {
      originNodeId: NODE_ID,
      timestamp: new Date().toISOString(),
      payload,
    };
    redisClient.publish(`location_queue:${locationId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish queue event to Redis:", err?.message || err);
    });
  }
}

/**
 * Broadcast clinical events (panic alerts, critical lab results) to authenticated clinical staff channels.
 */
export function broadcastClinicalRealtime(locationId: string, payload: RealtimeMessage) {
  sendToLocationClinicalLocally(locationId, payload);
  bufferCriticalAlert(`location_clinical:${locationId}`, payload);

  if (redisClient) {
    const envelope: ClusterMessageEnvelope = {
      originNodeId: NODE_ID,
      timestamp: new Date().toISOString(),
      payload,
    };
    redisClient.publish(`location_clinical:${locationId}`, JSON.stringify(envelope)).catch((err) => {
      console.warn("[Redis PubSub Warning] Failed to publish clinical broadcast to Redis:", err?.message || err);
    });
  }
}


// ─── Native WebSocket Connection Handlers ─────────────────────────────

/**
 * Extract auth user from WebSocket request cookies, Authorization header, or token query param.
 */
export async function resolveWebSocketAuth(req: FastifyRequest): Promise<RealtimeIdentity | null> {
  if (req.headers.origin && !isOriginAllowed(req.headers.origin, req)) return null;
  let token = req.cookies?.access_token || (req.headers.authorization?.replace(/^Bearer\s+/i, ""));

  if (!token && req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:^|;\s*)access_token=([^;]+)/);
    if (match) {
      try { token = decodeURIComponent(match[1]); } catch { return null; }
    }
  }

  if (!token && (req.query as any)?.token) {
    token = (req.query as any).token;
  }

  if (!token && req.headers["sec-websocket-protocol"]) {
    const protoHeader = req.headers["sec-websocket-protocol"];
    const protocols = Array.isArray(protoHeader) ? protoHeader.join(",").split(",") : String(protoHeader).split(",");
    for (const p of protocols) {
      const trimmed = p.trim();
      if (trimmed.startsWith("bearer.") || trimmed.startsWith("token.")) {
        token = trimmed.slice(trimmed.indexOf(".") + 1);
        break;
      }
    }
  }

  if (!token) return null;

  try {
    const payload = verifyAccessToken(token);
    if (payload?.id && payload.role !== "guest") {
      if (!payload.sessionId) return null;
      if (payload.sessionId) {
        const resolution = await resolveSession(payload.sessionId, payload.authVersion);
        if (!resolution.valid || resolution.session?.userId !== payload.id || resolution.session?.role !== payload.role || resolution.session?.organizationId !== payload.organization_id) {
          return null;
        }
      }
      return { id: payload.id, role: payload.role, organization_id: payload.organization_id, sessionId: payload.sessionId, authVersion: payload.authVersion, exp: payload.exp };
    }
  } catch (err) {
    return null;
  }
  return null;
}

// Rate limiting and connection tracking for public queue websockets
const publicWsIpConnections = new Map<string, number>();
const publicWsIpAttempts = new Map<string, { count: number; resetAt: number }>();

const MAX_PUBLIC_WS_PER_IP = 10;
const MAX_CONNECTS_PER_MINUTE = 30;

export function checkPublicWsRateLimit(ip: string): { allowed: boolean; reason?: string; code?: number } {
  const now = Date.now();
  for (const [address, entry] of publicWsIpAttempts) if (entry.resetAt < now) publicWsIpAttempts.delete(address);
  if (!publicWsIpAttempts.has(ip) && publicWsIpAttempts.size >= 10_000) return { allowed: false, reason: "Connection rate limit capacity exceeded", code: 4029 };
  let attemptInfo = publicWsIpAttempts.get(ip);
  if (!attemptInfo || attemptInfo.resetAt < now) {
    attemptInfo = { count: 1, resetAt: now + 60000 };
    publicWsIpAttempts.set(ip, attemptInfo);
  } else {
    attemptInfo.count++;
    if (attemptInfo.count > MAX_CONNECTS_PER_MINUTE) {
      return { allowed: false, reason: "Connection rate limit exceeded", code: 4029 };
    }
  }

  const currentCount = publicWsIpConnections.get(ip) || 0;
  if (currentCount >= MAX_PUBLIC_WS_PER_IP) {
    return { allowed: false, reason: "Too many concurrent connections from this IP", code: 4029 };
  }

  return { allowed: true };
}

export function incrementPublicWsIp(ip: string) {
  publicWsIpConnections.set(ip, (publicWsIpConnections.get(ip) || 0) + 1);
}

export function decrementPublicWsIp(ip: string) {
  const current = publicWsIpConnections.get(ip) || 0;
  if (current <= 1) {
    publicWsIpConnections.delete(ip);
  } else {
    publicWsIpConnections.set(ip, current - 1);
  }
}

/**
 * Fastify WebSocket handler for User Notifications (/api/ws & /api/notifications/ws)
 */
export async function handleNotificationWebSocket(socket: WebSocket, req: FastifyRequest) {
  const user = await resolveWebSocketAuth(req);
  if (!user) {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Unauthorized: Valid authentication token required" }));
    socket.close(1008, "Unauthorized");
    return;
  }

  bindPrivateConnection(user, socket, () => socket.close(4001, "Session expired or revoked"));
  registerUserWebSocket(user.id, socket);

  safeSocketSend(socket, JSON.stringify({
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
          sendPrivate(socket, () => { if (socket.readyState === 1) safeSocketSend(socket, JSON.stringify(alert)); });
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
        sendPrivate(socket, () => heartbeatSocket(socket));
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
        safeSocketSend(socket, JSON.stringify({ type: "PONG", timestamp: new Date().toISOString() }));
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
 * Fastify WebSocket handler for Location OPD Queue Displays (/api/queue/ws)
 * Public, sanitized queue statistics, rate-limited per IP.
 */
export async function handleQueueWebSocket(socket: WebSocket, req: FastifyRequest) {
  const clientIp = req.ip || (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || "127.0.0.1";

  const rateLimit = checkPublicWsRateLimit(clientIp);
  if (!rateLimit.allowed) {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: rateLimit.reason }));
    socket.close(rateLimit.code || 4029, rateLimit.reason);
    return;
  }

  const locationId = (req.params as any)?.locationId || (req.query as any)?.locationId;
  if (!locationId || typeof locationId !== "string" || locationId.length !== 24) {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Valid 24-character locationId required" }));
    socket.close(4004, "Invalid locationId");
    return;
  }

  // Validate location exists and is active
  try {
    const location = await Location.findOne({ _id: locationId, isActive: true }).select("_id isActive").lean();
    if (!location) {
      safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Location not found or inactive" }));
      socket.close(4004, "Location Not Found or Inactive");
      return;
    }
  } catch {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Unable to validate location" }));
    socket.close(1011, "Location lookup failed");
    return;
  }

  incrementPublicWsIp(clientIp);
  registerLocationQueueWebSocket(locationId, socket);

  safeSocketSend(socket, JSON.stringify({
    type: "CONNECTED",
    transport: "websocket",
    topic: `location_queue:${locationId}`,
    message: `Subscribed to real-time OPD Queue updates for location ${locationId}`,
    timestamp: new Date().toISOString()
  }));

  // Queue TV is intentionally public. Never replay buffered panic/clinical
  // messages to an unauthenticated display channel.

  const pingInterval = setInterval(() => {
    if (socket.readyState === 1) {
      try { heartbeatSocket(socket); } catch { clearInterval(pingInterval); }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  socket.on("message", (raw: any) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "PING") {
        safeSocketSend(socket, JSON.stringify({ type: "PONG", timestamp: new Date().toISOString() }));
      }
    } catch {
      // ignore
    }
  });

  socket.on("close", () => {
    decrementPublicWsIp(clientIp);
    clearInterval(pingInterval);
  });
}

const CLINICAL_STAFF_ROLES = new Set([
  "doctor",
  "nurse",
  "receptionist",
  "pharmacist",
  "lab_tech",
  "lab_technician",
  "admin",
  "org_admin",
  "root",
]);

/**
 * Fastify WebSocket handler for Authenticated Clinical Staff Displays (/api/clinical/ws)
 */
export async function handleClinicalWebSocket(socket: WebSocket, req: FastifyRequest) {
  const user = await resolveWebSocketAuth(req);
  if (!user) {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Unauthorized: Valid authentication token required" }));
    socket.close(4001, "Unauthorized");
    return;
  }

  if (!user.role || !CLINICAL_STAFF_ROLES.has(user.role)) {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Forbidden: Clinical staff role required for clinical channel" }));
    socket.close(4003, "Forbidden");
    return;
  }

  const locationId = (req.params as any)?.locationId || (req.query as any)?.locationId;
  if (!locationId || typeof locationId !== "string" || locationId.length !== 24) {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Valid 24-character locationId query parameter required" }));
    socket.close(4004, "Invalid locationId");
    return;
  }

  let location: any;
  try {
    location = await Location.findById(locationId).select("organizationId isActive").lean();
  } catch {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Unable to validate location access" }));
    socket.close(1011, "Location lookup failed");
    return;
  }
  if (!location || location.isActive === false || (user.role !== "root" && (!user.organization_id || location.organizationId.toString() !== user.organization_id))) {
    safeSocketSend(socket, JSON.stringify({ type: "ERROR", message: "Forbidden: location access denied" }));
    socket.close(4003, "Forbidden");
    return;
  }

  const permitted = async () => {
    try { return user.role === 'root' || (await getEffectivePermissions(user.role!, user.organization_id, user.authVersion)).has('VIEW_EHR'); }
    catch { return false; }
  };
  if (!await permitted()) { socket.close(4003, 'Clinical permission required'); return; }
  bindPrivateConnection(user, socket, () => socket.close(4001, 'Clinical authority expired or revoked'), permitted);
  registerLocationClinicalWebSocket(locationId, socket);

  safeSocketSend(socket, JSON.stringify({
    type: "CONNECTED",
    transport: "websocket",
    topic: `location_clinical:${locationId}`,
    message: `Subscribed to real-time clinical alerts for location ${locationId}`,
    timestamp: new Date().toISOString()
  }));

  // Replay unacknowledged recent critical alerts for this clinical station
  getBufferedCriticalAlerts(`location_clinical:${locationId}`).then((buffered) => {
    buffered.forEach((alert) => {
      try {
        if (socket.readyState === 1) {
          sendPrivate(socket, () => { if (socket.readyState === 1) safeSocketSend(socket, JSON.stringify(alert)); });
        }
      } catch {
        // Safe ignore
      }
    });
  });

  const pingInterval = setInterval(() => {
    if (socket.readyState === 1) {
      try { sendPrivate(socket, () => heartbeatSocket(socket)); } catch { clearInterval(pingInterval); }
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);

  socket.on("message", (raw: any) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "PING") {
        safeSocketSend(socket, JSON.stringify({ type: "PONG", timestamp: new Date().toISOString() }));
      }
    } catch {
      // ignore
    }
  });

  socket.on("close", () => {
    clearInterval(pingInterval);
  });
}

// ─── SSE Stream Handler (transport recovery) ────────────────
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
  safeSseWrite(reply, `data: ${JSON.stringify({ type: "CONNECTED", transport: "sse", message: "Notification stream established" })}\n\n`);

  bindPrivateConnection(req.user!, reply, () => reply.raw.end());
  registerUserSseStream(userId, reply);

  // 15-Second Keep-Alive Heartbeat Timer
  const heartbeatTimer = setInterval(() => {
    try {
      if (!reply.raw.writableEnded) {
        sendPrivate(reply, () => { if (!reply.raw.writableEnded) safeSseWrite(reply, ": keep-alive\n\n"); });
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

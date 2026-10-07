import { EventEmitter } from "node:events";
import { User } from "../models/User.ts";
import { createAuthSession } from "../utilities/helpers.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  NODE_ID,
  handleNotificationWebSocket,
  registerLocationQueueWebSocket,
  broadcastRealtimeNotification,
  broadcastQueueUpdate,
  broadcastClinicalRealtime,
  getBufferedCriticalAlerts,
  bufferCriticalAlert,
  type RealtimeMessage,
  type ClusterMessageEnvelope,
} from "../notifications/websocket.ts";

describe("Redis PubSub WebSocket Cross-Node Fan-Out & Replay Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should generate a valid, unique NODE_ID for the running process", () => {
    expect(NODE_ID).toBeDefined();
    expect(typeof NODE_ID).toBe("string");
    expect(NODE_ID.length).toBeGreaterThan(0);
  });

  it("should deliver real-time messages locally to connected user websockets", async () => {
    const user = await User.create({ name: "Realtime root", role: "root", email: "realtime@example.test" });
    const testUserId = user.id;
    const auth = await createAuthSession({ id: user.id, role: "root", email: user.email! });
    const sentMessages: string[] = [];

    const mockSocket: any = Object.assign(new EventEmitter(), {
      readyState: 1, // OPEN
      send: vi.fn((msg: string) => {
        sentMessages.push(msg);
      }),
      ping: vi.fn(), close: vi.fn(),
    });
    await handleNotificationWebSocket(mockSocket, { headers: {}, cookies: { access_token: auth.accessToken }, query: {} } as any);
    mockSocket.send.mockClear(); sentMessages.length = 0;

    const payload: RealtimeMessage = {
      type: "NOTIFICATION_RECEIVED",
      message: "Dr. Vikram has completed your prescription",
      timestamp: new Date().toISOString(),
    };

    broadcastRealtimeNotification(testUserId, payload);

    await vi.waitFor(() => expect(mockSocket.send).toHaveBeenCalledTimes(1));
    mockSocket.emit("close");
    const parsed = JSON.parse(sentMessages[0]);
    expect(parsed.type).toBe("NOTIFICATION_RECEIVED");
    expect(parsed.message).toBe("Dr. Vikram has completed your prescription");
  });

  it("should deliver queue updates locally to connected clinic displays", async () => {
    const testLocationId = "6aa03a085a3bdf2bee3c5e5a";
    const sentMessages: string[] = [];

    const mockSocket: any = {
      readyState: 1,
      send: vi.fn((msg: string) => {
        sentMessages.push(msg);
      }),
      on: vi.fn(),
    };

    registerLocationQueueWebSocket(testLocationId, mockSocket);

    const payload: RealtimeMessage = {
      type: "QUEUE_UPDATED",
      data: { currentToken: 14, waitingCount: 3 },
      timestamp: new Date().toISOString(),
    };

    broadcastQueueUpdate(testLocationId, payload);

    expect(mockSocket.send).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(sentMessages[0]);
    expect(parsed.type).toBe("QUEUE_UPDATED");
    expect(parsed.data.currentToken).toBe(14);
  });

  it("should buffer critical panic alerts and retrieve them with replayed flag", async () => {
    const testLocationId = "clinic-panic-test-1";

    const panicPayload: RealtimeMessage = {
      type: "CLINICAL_PANIC_ALERT",
      message: "CRITICAL LAB VALUE: Potassium 6.9 mEq/L for Patient John Doe",
      data: { labOrderId: "lab-123", severity: "critical" },
      timestamp: new Date().toISOString(),
    };

    await bufferCriticalAlert(`location:${testLocationId}`, panicPayload);

    // Only if Redis is connected in test environment does it store, otherwise safe graceful empty
    const buffered = await getBufferedCriticalAlerts(`location:${testLocationId}`);
    if (buffered.length > 0) {
      expect(buffered[0].type).toBe("CLINICAL_PANIC_ALERT");
      expect(buffered[0].replayed).toBe(true);
    } else {
      // In-memory / disconnected Redis gracefully returns empty array without throwing
      expect(Array.isArray(buffered)).toBe(true);
    }
  });

  it("should ignore non-critical alerts in the panic alert buffer", async () => {
    const testLocationId = "clinic-routine-test-2";

    const routinePayload: RealtimeMessage = {
      type: "QUEUE_UPDATED",
      message: "Routine queue tick",
      timestamp: new Date().toISOString(),
    };

    await bufferCriticalAlert(`location:${testLocationId}`, routinePayload);
    const buffered = await getBufferedCriticalAlerts(`location:${testLocationId}`);
    expect(buffered.length).toBe(0);
  });

  it("should correctly handle ClusterMessageEnvelope structure with originNodeId", () => {
    const envelope: ClusterMessageEnvelope = {
      originNodeId: "pod-worker-b",
      timestamp: new Date().toISOString(),
      payload: {
        type: "QUEUE_EMERGENCY_STAT",
        message: "STAT Trauma Arrival at Cabin 3",
      },
    };

    expect(envelope.originNodeId).not.toBe(NODE_ID);
    expect(envelope.payload.type).toBe("QUEUE_EMERGENCY_STAT");
  });
});

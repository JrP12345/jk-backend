import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_PAGINATION_LIMIT,
  DEFAULT_PAGINATION_LIMIT,
  MAX_REPORT_RANGE_DAYS,
  MAX_REPORT_ROWS,
  MAX_AI_CONTEXT_TURNS,
  MAX_AI_SESSION_MESSAGES,
  MAX_EVENT_RETRY_COUNT,
  MAX_OUTBOUND_RETRY_COUNT,
  DB_POOL_SIZE,
  TENANT_RATE_LIMIT_PER_MINUTE,
  DOMAIN_EVENT_WORKER_BATCH_SIZE,
  OUTBOUND_MESSAGE_WORKER_BATCH_SIZE,
} from "../utilities/scalability.ts";
import {
  getCachedPermissions,
  setCachedPermissions,
  invalidateLocalPermissionCache,
  isSessionFamilyRevoked,
  revokeSessionFamily,
  withLeaderGuard,
} from "../utilities/replicaCoordination.ts";
import { tenantRateLimiter } from "../middleware/tenantRateLimiter.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";
import { outboundMessageDeliveryWorker } from "../services/OutboundMessageDeliveryWorker.ts";

describe("Phase 6 — Scalability & Multi-Replica Coordination Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Step 6.4 — Centralized Resource Budgets", () => {
    it("should export sensible production defaults for all resource budgets", () => {
      expect(MAX_REQUEST_BODY_BYTES).toBe(10 * 1024 * 1024);
      expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
      expect(MAX_PAGINATION_LIMIT).toBe(100);
      expect(DEFAULT_PAGINATION_LIMIT).toBe(20);
      expect(MAX_REPORT_RANGE_DAYS).toBe(365);
      expect(MAX_REPORT_ROWS).toBe(10_000);
      expect(MAX_AI_CONTEXT_TURNS).toBe(8);
      expect(MAX_AI_SESSION_MESSAGES).toBe(500);
      expect(MAX_EVENT_RETRY_COUNT).toBe(5);
      expect(MAX_OUTBOUND_RETRY_COUNT).toBe(5);
      expect(DB_POOL_SIZE).toBeGreaterThan(0);
      expect(TENANT_RATE_LIMIT_PER_MINUTE).toBe(2_000);
      expect(DOMAIN_EVENT_WORKER_BATCH_SIZE).toBe(10);
      expect(OUTBOUND_MESSAGE_WORKER_BATCH_SIZE).toBe(5);
    });
  });

  describe("Step 6.2 — Multi-Replica In-Memory Cache Invalidation & Session Revocation", () => {
    it("should cache and invalidate user permissions locally", () => {
      const userId = "user-test-coord-1";
      expect(getCachedPermissions(userId)).toBeNull();

      setCachedPermissions(userId, ["VIEW_CLINICS", "MANAGE_APPOINTMENTS"]);
      expect(getCachedPermissions(userId)).toEqual(["VIEW_CLINICS", "MANAGE_APPOINTMENTS"]);

      invalidateLocalPermissionCache(userId);
      expect(getCachedPermissions(userId)).toBeNull();
    });

    it("should track revoked session families and verify revocation state", async () => {
      const familyId = "fam_test_998877";
      expect(isSessionFamilyRevoked(familyId)).toBe(false);

      await revokeSessionFamily(familyId);
      expect(isSessionFamilyRevoked(familyId)).toBe(true);
    });

    it("should guard scheduled jobs so only the active leader executes", async () => {
      let isLeaderFlag = false;
      let executedCount = 0;

      const job = withLeaderGuard("test-sweep", () => isLeaderFlag, async () => {
        executedCount++;
      });

      // When replica is not leader, job skips silently
      await job();
      expect(executedCount).toBe(0);

      // When replica acquires leadership, job executes
      isLeaderFlag = true;
      await job();
      expect(executedCount).toBe(1);

      // When replica loses leadership, job stops executing
      isLeaderFlag = false;
      await job();
      expect(executedCount).toBe(1);
    });
  });

  describe("Step 6.4 — Tenant Rate Limiting Middleware", () => {
    it("should ignore unauthenticated requests (leaving them to IP rate limiting)", async () => {
      const req: any = { user: undefined };
      const reply: any = {
        header: vi.fn(),
        code: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await tenantRateLimiter(req, reply);
      expect(reply.code).not.toHaveBeenCalled();
      expect(reply.header).not.toHaveBeenCalled();
    });

    it("should add tenant rate limit headers to authenticated requests", async () => {
      const orgId = "org_test_rate_1";
      const req: any = { user: { id: "u1", organization_id: orgId } };
      const headers: Record<string, any> = {};
      const reply: any = {
        header: vi.fn((key: string, val: any) => { headers[key] = val; }),
        code: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await tenantRateLimiter(req, reply);
      expect(headers["X-Tenant-RateLimit-Limit"]).toBe(TENANT_RATE_LIMIT_PER_MINUTE);
      expect(headers["X-Tenant-RateLimit-Remaining"]).toBeLessThanOrEqual(TENANT_RATE_LIMIT_PER_MINUTE);
      expect(reply.code).not.toHaveBeenCalled();
    });
  });

  describe("Step 6.3 — Worker Scaling & Metrics", () => {
    it("should expose real-time metrics for DomainEventDeliveryWorker", async () => {
      const metrics = await domainEventDeliveryWorker.getMetrics();
      expect(metrics).toBeDefined();
      expect(typeof metrics.pendingCount).toBe("number");
      expect(typeof metrics.processingCount).toBe("number");
      expect(typeof metrics.retryingCount).toBe("number");
      expect(typeof metrics.deadLetterCount).toBe("number");
    });

    it("should expose real-time metrics for OutboundMessageDeliveryWorker", async () => {
      const metrics = await outboundMessageDeliveryWorker.getMetrics();
      expect(metrics).toBeDefined();
      expect(typeof metrics.pendingCount).toBe("number");
      expect(typeof metrics.processingCount).toBe("number");
      expect(typeof metrics.retryingCount).toBe("number");
      expect(typeof metrics.sentCount).toBe("number");
      expect(typeof metrics.failedCount).toBe("number");
      expect(typeof metrics.inBackpressure).toBe("boolean");
    });
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowEngine } from "../platform/workflow/WorkflowEngine.ts";
import type { WorkflowDefinition } from "../platform/workflow/types.ts";
import { WorkflowError } from "../platform/workflow/WorkflowError.ts";
import { DomainEventBus, domainEventBus } from "../platform/events/DomainEventBus.ts";
import { createDomainEvent } from "../platform/events/DomainEvent.ts";
import { EventTypes } from "../platform/events/types.ts";

describe("Platform Services (WorkflowEngine & DomainEventBus) Integration Tests", () => {
  beforeEach(() => {
    domainEventBus.clear();
  });

  // ─── Test Group 1: Generic WorkflowEngine Mechanics ────────────────────────
  describe("WorkflowEngine Unit & Lifecycle Tests", () => {
    const testWorkflowDef: WorkflowDefinition<"draft" | "submitted" | "approved" | "rejected"> = {
      name: "TestApprovalWorkflow",
      initial: "draft",
      terminal: ["approved", "rejected"],
      transitions: {
        draft: ["submitted", "rejected"],
        submitted: ["approved", "rejected"],
        approved: [],
        rejected: [],
      },
    };

    it("should allow valid state transitions and report terminal status correctly", () => {
      const engine = new WorkflowEngine(testWorkflowDef);

      expect(engine.isTerminal("draft")).toBe(false);
      expect(engine.isTerminal("approved")).toBe(true);

      expect(() => engine.validateTransition("draft", "submitted")).not.toThrow();
      expect(() => engine.validateTransition("submitted", "approved")).not.toThrow();
    });

    it("should throw WorkflowError with transition metadata on invalid forward move", () => {
      const engine = new WorkflowEngine(testWorkflowDef);

      try {
        engine.validateTransition("draft", "approved");
        expect.fail("Should have thrown WorkflowError");
      } catch (err: any) {
        expect(err).toBeInstanceOf(WorkflowError);
        expect(err.currentStatus).toBe("draft");
        expect(err.targetStatus).toBe("approved");
        expect(err.allowedTransitions).toEqual(["submitted", "rejected"]);
        expect(err.isTerminal).toBe(false);
      }
    });

    it("should throw WorkflowError with isTerminal=true when attempting to transition out of a terminal state", () => {
      const engine = new WorkflowEngine(testWorkflowDef);

      try {
        engine.validateTransition("approved", "draft");
        expect.fail("Should have thrown WorkflowError for terminal state");
      } catch (err: any) {
        expect(err).toBeInstanceOf(WorkflowError);
        expect(err.isTerminal).toBe(true);
        expect(err.message).toContain("terminal status");
      }
    });

    it("should execute before and after hooks during transition()", async () => {
      const engine = new WorkflowEngine(testWorkflowDef);
      const hookOrder: string[] = [];

      const result = await engine.transition({
        currentState: "draft",
        targetState: "submitted",
        context: { docId: "doc-123" },
        before: async (ctx) => {
          hookOrder.push(`before-${ctx?.docId}`);
        },
        after: async (ctx) => {
          hookOrder.push(`after-${ctx?.docId}`);
        },
      });

      expect(result.previousState).toBe("draft");
      expect(result.state).toBe("submitted");
      expect(hookOrder).toEqual(["before-doc-123", "after-doc-123"]);
    });
  });

  // ─── Test Group 2: DomainEventBus Pub-Sub & Multi-Subscriber Isolation ──────
  describe("DomainEventBus Pub-Sub & Isolation Tests", () => {
    it("should publish events to single and multiple subscribers deterministically", async () => {
      const bus = new DomainEventBus();
      const received1: any[] = [];
      const received2: any[] = [];
      const received3: any[] = [];

      // Multi-subscriber setup for ResultUploaded (Timeline, Analytics, CDS)
      bus.subscribe(EventTypes.RESULT_UPLOADED, (e) => { received1.push(e.payload); });
      bus.subscribe(EventTypes.RESULT_UPLOADED, (e) => { received2.push(e.payload); });
      bus.subscribe(EventTypes.RESULT_UPLOADED, (e) => { received3.push(e.payload); });

      expect(bus.getSubscriberCount(EventTypes.RESULT_UPLOADED)).toBe(3);

      const event = createDomainEvent(EventTypes.RESULT_UPLOADED, {
        orderId: "ord-99",
        testCode: "CBC",
        value: "14.2",
        isAbnormal: true,
      });

      await bus.publish(event);

      expect(received1).toHaveLength(1);
      expect(received2).toHaveLength(1);
      expect(received3).toHaveLength(1);
      expect(received1[0].orderId).toBe("ord-99");
      expect(received2[0].isAbnormal).toBe(true);
    });

    it("should isolate subscriber exceptions so a failing listener does not break others", async () => {
      const bus = new DomainEventBus();
      const successfulHits: string[] = [];

      // Subscriber 1: fails
      bus.subscribe("TestEvent", () => {
        throw new Error("Subscriber 1 exploded!");
      });

      // Subscriber 2: succeeds
      bus.subscribe("TestEvent", () => {
        successfulHits.push("sub2");
      });

      const event = createDomainEvent("TestEvent", { message: "hello" });

      // Should not throw to caller
      await expect(bus.publish(event)).resolves.not.toThrow();
      expect(successfulHits).toEqual(["sub2"]);
    });

    it("should support unsubscribing cleanly", async () => {
      const bus = new DomainEventBus();
      let callCount = 0;

      const unsubscribe = bus.subscribe("TestEvent", () => {
        callCount++;
      });

      await bus.publishEvent("TestEvent", {});
      expect(callCount).toBe(1);

      unsubscribe();
      await bus.publishEvent("TestEvent", {});
      expect(callCount).toBe(1); // Didn't increment
    });
  });
});

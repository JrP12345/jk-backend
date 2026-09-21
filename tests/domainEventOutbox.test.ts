import { beforeEach, describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { DomainEventOutbox } from "../models/DomainEventOutbox.ts";
import { eventBus } from "../events/eventBus.ts";
import { domainEventBus } from "../platform/events/DomainEventBus.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";
import { readEncryptedDomainEvent } from "../services/DomainEventOutboxService.ts";
import { generateAccessToken } from "../utilities/helpers.ts";

describe("Durable Domain Event Outbox", () => {
  let rootCookie: string;
  let rootUser: any;

  beforeEach(async () => {
    await DomainEventOutbox.deleteMany({});
    await User.deleteMany({ email: "outbox-domain-root@test.local" });

    rootUser = await User.create({
      name: "Outbox Domain Root",
      email: "outbox-domain-root@test.local",
      password: "Password123!",
      role: "root",
    });

    rootCookie = `access_token=${generateAccessToken({
      id: rootUser._id.toString(),
      email: rootUser.email!,
      role: "root",
    })}`;
  });

  it("persists domain event to DomainEventOutbox with encrypted payload", async () => {
    const eventId = `test_evt_${Date.now()}`;
    await eventBus.publishDurable({
      eventId,
      eventType: "TEST_DURABLE_EVENT",
      category: "system",
      title: "Sensitive PHI Title",
      message: "Sensitive clinical narrative details",
      metadata: { patientSecret: "confidential_data" },
    });

    // Verify persisted
    const defaultDoc = await DomainEventOutbox.findOne({ idempotencyKey: eventId });
    expect(defaultDoc).toBeDefined();
    expect(defaultDoc?.status).toBe("pending");
    expect(defaultDoc?.eventType).toBe("TEST_DURABLE_EVENT");
    // Normal projection must NOT include payloadCiphertext
    expect((defaultDoc as any)?.payloadCiphertext).toBeUndefined();

    // Explicit selection allows decryption
    const docWithCiphertext = await DomainEventOutbox.findOne({ idempotencyKey: eventId }).select("+payloadCiphertext");
    expect(docWithCiphertext?.payloadCiphertext).toBeDefined();
    const decrypted = readEncryptedDomainEvent(docWithCiphertext!);
    expect(decrypted.eventId).toBe(eventId);
    expect(decrypted.title).toBe("Sensitive PHI Title");
    expect(decrypted.metadata?.patientSecret).toBe("confidential_data");
  });

  it("ensures idempotent enqueue — duplicates return existing row", async () => {
    const eventId = `idempotent_evt_${Date.now()}`;
    await eventBus.publishDurable({
      eventId,
      eventType: "TEST_IDEMPOTENT_EVENT",
      category: "patient",
      title: "First Publish",
    });

    // Publish again with same eventId
    await eventBus.publishDurable({
      eventId,
      eventType: "TEST_IDEMPOTENT_EVENT",
      category: "patient",
      title: "Second Publish Attempt",
    });

    const count = await DomainEventOutbox.countDocuments({ idempotencyKey: eventId });
    expect(count).toBe(1);
  });

  it("worker processes pending event and dispatches to subscribers", async () => {
    const eventId = `dispatch_evt_${Date.now()}`;
    const receivedInEventBus: any[] = [];
    const receivedInDomainBus: any[] = [];

    const busHandler = (payload: any) => {
      receivedInEventBus.push(payload);
    };
    eventBus.subscribe("TEST_DISPATCH_EVENT", busHandler);

    const unsubDomain = domainEventBus.subscribe("TEST_DISPATCH_EVENT", (event) => {
      receivedInDomainBus.push(event);
    });

    try {
      await eventBus.publishDurable({
        eventId,
        eventType: "TEST_DISPATCH_EVENT",
        category: "clinical",
        title: "Dispatch Ready",
      });

      const processed = await domainEventDeliveryWorker.processOne();
      expect(processed).toBe(true);

      const updated = await DomainEventOutbox.findOne({ idempotencyKey: eventId });
      expect(updated?.status).toBe("sent");
      expect(updated?.sentAt).toBeDefined();

      expect(receivedInEventBus.length).toBe(1);
      expect(receivedInEventBus[0].title).toBe("Dispatch Ready");

      expect(receivedInDomainBus.length).toBe(1);
      expect(receivedInDomainBus[0].payload.title).toBe("Dispatch Ready");
    } finally {
      eventBus.off("TEST_DISPATCH_EVENT", busHandler);
      unsubDomain();
    }
  });

  it("marks terminal failure and allows dead-letter list & replay via admin operations", async () => {
    const failedDoc = await DomainEventOutbox.create({
      idempotencyKey: `failed_event_${Date.now()}`,
      eventType: "ANANTA_DEAD_LETTER_EVENT",
      payloadCiphertext: "corrupted_ciphertext_for_test",
      status: "failed",
      attempts: 5,
      maxAttempts: 5,
      error: "Ciphertext decryption failed",
      sentAt: new Date(),
    });

    // 1. Root admin lists dead-letters with kind=domain_event
    const listRes = await app.inject({
      method: "GET",
      url: "/api/admin/operations/dead-letters?kind=domain_event",
      headers: { cookie: rootCookie },
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    expect(listBody.success).toBe(true);
    const item = listBody.data.find((d: any) => d.id === failedDoc._id.toString());
    expect(item).toBeDefined();
    expect(item.deliveryKind).toBe("ANANTA_DEAD_LETTER_EVENT");
    expect(item.payload).toBeUndefined();
    expect(item.payloadCiphertext).toBeUndefined();

    // 2. Root admin replays the dead letter
    const replayUrl = `/api/admin/operations/dead-letters/domain_event/${failedDoc._id}/replay`;
    const replayRes = await app.inject({
      method: "POST",
      url: replayUrl,
      headers: { cookie: rootCookie },
      payload: { confirmation: "REPLAY" },
    });
    expect(replayRes.statusCode).toBe(200);

    const reloaded = await DomainEventOutbox.findById(failedDoc._id);
    expect(reloaded?.status).toBe("pending");
    expect(reloaded?.attempts).toBe(0);
    expect(reloaded?.replayCount).toBe(1);
  });
});

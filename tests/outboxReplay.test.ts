import { beforeEach, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { app } from "../index.js";
import { User } from "../models/User.ts";
import { Notification } from "../models/Notification.ts";
import { NotificationDelivery } from "../models/NotificationDelivery.ts";
import { OutboundMessage } from "../models/OutboundMessage.ts";
import { AuditLog } from "../models/AuditLog.ts";
import { generateAccessToken } from "../utilities/helpers.ts";

describe("Dead-letter replay operations", () => {
  let rootCookie: string;
  let adminCookie: string;
  let rootUser: any;

  beforeEach(async () => {
    await Promise.all([
      NotificationDelivery.deleteMany({}),
      OutboundMessage.deleteMany({}),
      Notification.deleteMany({}),
      User.deleteMany({ email: { $in: ["outbox-root@test.local", "outbox-admin@test.local"] } }),
    ]);

    rootUser = await User.create({
      name: "Outbox Root",
      email: "outbox-root@test.local",
      password: "Password123!",
      role: "root",
    });
    const adminUser = await User.create({
      name: "Outbox Admin",
      email: "outbox-admin@test.local",
      password: "Password123!",
      role: "admin",
    });
    rootCookie = `access_token=${generateAccessToken({ id: rootUser._id.toString(), email: rootUser.email!, role: "root" })}`;
    adminCookie = `access_token=${generateAccessToken({ id: adminUser._id.toString(), email: adminUser.email!, role: "admin" })}`;
  });

  it("keeps PHI-bearing delivery fields out of the root dead-letter listing", async () => {
    const notification = await Notification.create({
      targetUser: rootUser._id,
      category: "patient",
      type: "TEST_FAILURE",
      title: "Sensitive title",
      message: "Sensitive clinical text",
    });
    await NotificationDelivery.create({
      notificationId: notification._id,
      channel: "email",
      recipient: "patient@example.test",
      title: "Sensitive title",
      message: "Sensitive clinical text",
      status: "failed",
      attempts: 5,
      maxAttempts: 5,
      error: "SMTP unavailable",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/operations/dead-letters?kind=notification_delivery",
      headers: { cookie: rootCookie },
    });
    expect(response.statusCode).toBe(200);
    const item = JSON.parse(response.body).data[0];
    expect(item.deliveryKind).toBe("email");
    expect(item.recipient).toBeUndefined();
    expect(item.message).toBeUndefined();
    expect(item.payload).toBeUndefined();
  });

  it("requires platform-root access and explicit confirmation before bounded replay", async () => {
    const message = await OutboundMessage.create({
      kind: "payment_receipt",
      idempotencyKey: `failed-receipt:${Date.now()}`,
      payload: { appointmentId: new mongoose.Types.ObjectId().toString(), transactionId: "gateway-secret" },
      status: "failed",
      attempts: 5,
      maxAttempts: 5,
      error: "Provider timeout",
    });
    const url = `/api/admin/operations/dead-letters/outbound_message/${message._id}/replay`;

    expect((await app.inject({ method: "POST", url, payload: { confirmation: "REPLAY" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: { cookie: adminCookie }, payload: { confirmation: "REPLAY" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: { cookie: rootCookie }, payload: {} })).statusCode).toBe(400);

    const replay = await app.inject({
      method: "POST",
      url,
      headers: { cookie: rootCookie },
      payload: { confirmation: "REPLAY" },
    });
    expect(replay.statusCode).toBe(200);

    const requeued = await OutboundMessage.findById(message._id);
    expect(requeued?.status).toBe("pending");
    expect(requeued?.attempts).toBe(0);
    expect(requeued?.replayCount).toBe(1);
    expect(requeued?.error).toBeUndefined();
    expect(requeued?.lastReplayedBy?.toString()).toBe(rootUser._id.toString());
    const audit = await AuditLog.findOne({ action: "OUTBOX_DEAD_LETTER_REPLAYED", targetId: message._id });
    expect(audit).toBeTruthy();
    expect(audit?.details.attemptsBeforeReplay).toBe(5);
  });
});

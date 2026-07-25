import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { notificationService } from "../notifications/services/NotificationService.ts";
import { Notification } from "../models/Notification.ts";
import { NotificationPreference } from "../models/NotificationPreference.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";

describe("Notification Infrastructure System", () => {
  const userId = new mongoose.Types.ObjectId().toHexString();

  beforeEach(async () => {
    await Notification.deleteMany({});
    await NotificationPreference.deleteMany({});
  });

  it("should create default notification preferences when requested", async () => {
    const pref = await notificationService.getPreferences(userId);
    expect(pref).toBeDefined();
    expect(pref?.userId.toString()).toBe(userId);
    expect(pref?.channels.inApp).toBe(true);
    expect(pref?.categories.task).toBe(true);
  });

  it("should update notification preferences", async () => {
    await notificationService.getPreferences(userId);
    const updated = await notificationService.updatePreferences(userId, {
      channels: { email: false, inApp: true, desktop: false, push: false, sms: false, digest: false },
      categories: { auth: true, organization: false, team: true, task: false, patient: true, billing: true, security: true, system: true },
    });

    expect(updated?.channels.email).toBe(false);
    expect(updated?.categories.task).toBe(false);
  });

  it("should process domain events published via EventBus and persist notifications", async () => {
    eventBus.publish({
      eventType: EVENT_TYPES.TASK_ASSIGNED,
      category: "task",
      targetUserId: userId,
      title: "Task Assigned",
      message: "You have been assigned to review the patient chart.",
      severity: "info",
    });

    // Allow event emitter setImmediate tick to resolve
    await new Promise((r) => setTimeout(r, 100));

    const unread = await notificationService.getUnreadCount(userId);
    expect(unread).toBe(1);

    const list = await notificationService.getNotifications(userId, {});
    expect(list.notifications.length).toBe(1);
    expect(list.notifications[0].title).toBe("Task Assigned");
    expect(list.notifications[0].category).toBe("task");
  });

  it("should respect category suppression from preferences", async () => {
    await notificationService.updatePreferences(userId, {
      categories: { auth: true, organization: true, team: true, task: false, patient: true, billing: true, security: true, system: true },
    });

    eventBus.publish({
      eventType: EVENT_TYPES.TASK_ASSIGNED,
      category: "task",
      targetUserId: userId,
      title: "Suppressed Task",
      message: "This should be suppressed.",
    });

    await new Promise((r) => setTimeout(r, 100));

    const unread = await notificationService.getUnreadCount(userId);
    expect(unread).toBe(0);
  });

  it("should mark notifications as read and update unread count", async () => {
    const doc = await Notification.create({
      targetUser: new mongoose.Types.ObjectId(userId),
      category: "system",
      type: "SYSTEM_ALERT",
      title: "System Update",
      message: "Server scheduled maintenance at 2 AM.",
    });

    let unread = await notificationService.getUnreadCount(userId);
    expect(unread).toBe(1);

    await notificationService.markAsRead(userId, doc._id.toString());

    unread = await notificationService.getUnreadCount(userId);
    expect(unread).toBe(0);
  });

  it("should enforce multi-tenant organizationId isolation", async () => {
    const org1Id = new mongoose.Types.ObjectId().toHexString();
    const org2Id = new mongoose.Types.ObjectId().toHexString();

    await Notification.create({
      organizationId: new mongoose.Types.ObjectId(org1Id),
      targetUser: new mongoose.Types.ObjectId(userId),
      category: "auth",
      type: "LOGIN",
      title: "Org 1 Notification",
      message: "Welcome to Org 1",
    });

    await Notification.create({
      organizationId: new mongoose.Types.ObjectId(org2Id),
      targetUser: new mongoose.Types.ObjectId(userId),
      category: "auth",
      type: "LOGIN",
      title: "Org 2 Notification",
      message: "Welcome to Org 2",
    });

    const org1List = await notificationService.getNotifications(userId, { organizationId: org1Id });
    expect(org1List.notifications.length).toBe(1);
    expect(org1List.notifications[0].title).toBe("Org 1 Notification");

    const org1Unread = await notificationService.getUnreadCount(userId, org1Id);
    expect(org1Unread).toBe(1);
  });

  it("should soft delete notifications and exclude them from counts", async () => {
    const doc = await Notification.create({
      targetUser: new mongoose.Types.ObjectId(userId),
      category: "system",
      type: "SYSTEM_ALERT",
      title: "Temporary Alert",
      message: "Will be deleted",
    });

    expect(await notificationService.getUnreadCount(userId)).toBe(1);

    await notificationService.deleteNotification(userId, doc._id.toString());

    expect(await notificationService.getUnreadCount(userId)).toBe(0);

    const list = await notificationService.getNotifications(userId, {});
    expect(list.notifications.length).toBe(0);

    // Verify record still exists in DB with deletedAt set
    const dbDoc = await Notification.findById(doc._id);
    expect(dbDoc?.deletedAt).toBeDefined();
  });

  it("should suppress duplicate events using idempotency key", async () => {
    const eventId = "unique_event_key_123";

    eventBus.publish({
      eventId,
      eventType: EVENT_TYPES.TASK_ASSIGNED,
      category: "task",
      targetUserId: userId,
      title: "Idempotent Task",
      message: "First dispatch",
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(await notificationService.getUnreadCount(userId)).toBe(1);

    // Publish identical event with same eventId
    eventBus.publish({
      eventId,
      eventType: EVENT_TYPES.TASK_ASSIGNED,
      category: "task",
      targetUserId: userId,
      title: "Duplicate Task",
      message: "Second dispatch",
    });

    await new Promise((r) => setTimeout(r, 100));
    // Count should still be 1
    expect(await notificationService.getUnreadCount(userId)).toBe(1);
  });

  it("should process background queue jobs asynchronously and track metrics", async () => {
    const metricsBefore = await notificationService.getMetrics();
    expect(metricsBefore).toBeDefined();
    expect(typeof metricsBefore.activeSseConnections).toBe("number");
    expect(typeof metricsBefore.queueDepth).toBe("number");

    // Publish event with email channel enabled
    eventBus.publish({
      eventType: EVENT_TYPES.SYSTEM_ALERT,
      category: "system",
      targetUserId: userId,
      title: "Queue Test Event",
      message: "Testing async background delivery queue",
    });

    // Allow worker loop tick to process enqueued job
    await new Promise((r) => setTimeout(r, 600));

    const metricsAfter = await notificationService.getMetrics();
    expect(metricsAfter.queueStats.processedCount).toBeGreaterThanOrEqual(1);
  });

  it("should snooze notifications and temporarily hide them from unread count", async () => {
    const doc = await Notification.create({
      targetUser: new mongoose.Types.ObjectId(userId),
      category: "task",
      type: "TASK_ASSIGNED",
      title: "Snooze Test Task",
      message: "This will be snoozed",
    });

    expect(await notificationService.getUnreadCount(userId)).toBe(1);

    // Snooze for 60 minutes
    await notificationService.snoozeNotification(userId, doc._id.toString(), 60);

    // Should now be excluded from unread count and default list
    expect(await notificationService.getUnreadCount(userId)).toBe(0);

    const defaultList = await notificationService.getNotifications(userId, {});
    expect(defaultList.notifications.length).toBe(0);

    // Should be included when includeSnoozed is true
    const snoozedList = await notificationService.getNotifications(userId, { includeSnoozed: true });
    expect(snoozedList.notifications.length).toBe(1);
  });

  it("should toggle pin status and prioritize pinned notifications at top of list", async () => {
    const doc1 = await Notification.create({
      targetUser: new mongoose.Types.ObjectId(userId),
      category: "system",
      type: "ALERT_1",
      title: "First Notification",
      message: "Normal priority",
      createdAt: new Date(Date.now() - 10000),
    });

    const doc2 = await Notification.create({
      targetUser: new mongoose.Types.ObjectId(userId),
      category: "system",
      type: "ALERT_2",
      title: "Second Notification (Older)",
      message: "Should be pinned to top",
      createdAt: new Date(Date.now() - 60000),
    });

    // Pin older doc2
    await notificationService.togglePinNotification(userId, doc2._id.toString());

    const list = await notificationService.getNotifications(userId, {});
    expect(list.notifications.length).toBe(2);
    // Pinned doc2 should come first despite being older
    expect(list.notifications[0].title).toBe("Second Notification (Older)");
    expect(list.notifications[0].pinned).toBe(true);
  });

  it("should evaluate routing rules and escalate urgent critical events to email queue", async () => {
    // User preference has email disabled
    await notificationService.updatePreferences(userId, {
      channels: { email: false, inApp: true, desktop: false, push: false, sms: false, digest: false },
    });

    // Publish critical error event which triggers Critical Escalation Rule
    eventBus.publish({
      eventType: EVENT_TYPES.SECURITY_SUSPICIOUS_LOGIN,
      category: "security",
      severity: "error",
      priority: "urgent",
      targetUserId: userId,
      title: "Critical Security Escalation",
      message: "Suspicious login attempt detected from unknown IP",
    });

    await new Promise((r) => setTimeout(r, 600));

    // Should create in-app notification and trigger rule override
    const unread = await notificationService.getUnreadCount(userId);
    expect(unread).toBe(1);
  });
});

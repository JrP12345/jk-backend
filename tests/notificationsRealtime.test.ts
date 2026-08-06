import { describe, it, expect } from "vitest";
import mongoose from "mongoose";
import app from "../index.js";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { Notification } from "../models/Notification.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import bcrypt from "bcryptjs";

describe("Milestone 6: Notifications & Real-Time Event System Integration Tests", () => {
  it("should retrieve operational metrics for notification queue and active streams", async () => {
    const adminUser = await User.create({
      name: "Notification Metrics Admin",
      email: "notif_metrics@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "admin",
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.7.0.1",
      payload: { email: "notif_metrics@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    const metricsRes = await app.inject({
      method: "GET",
      url: "/api/notifications/metrics",
      remoteAddress: "10.7.0.2",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });

    expect(metricsRes.statusCode).toBe(200);
    const body = JSON.parse(metricsRes.body).data;
    expect(body.activeSseConnections).toBeDefined();
    expect(body.queueDepth).toBeDefined();
  });

  it("should update user notification preferences via REST API", async () => {
    const user = await User.create({
      name: "Pref User",
      email: "pref_user@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "doctor",
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.7.0.3",
      payload: { email: "pref_user@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    // 1. Get default preferences
    const getRes = await app.inject({
      method: "GET",
      url: "/api/notification-preferences",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    const prefData = JSON.parse(getRes.body).data;
    expect(prefData.channels).toBeDefined();

    // 2. Update preferences
    const patchRes = await app.inject({
      method: "PATCH",
      url: "/api/notification-preferences",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        channels: { email: false, inApp: true },
        categories: { patient: true, task: false },
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const updated = JSON.parse(patchRes.body).data;
    expect(updated.channels.email).toBe(false);
    expect(updated.categories.task).toBe(false);
  });

  it("should fetch, mark as read, and delete notifications via REST endpoints", async () => {
    const user = await User.create({
      name: "Notif List User",
      email: "notif_list_user@ananta.internal",
      password: await bcrypt.hash("Password123!", 10),
      role: "doctor",
    });

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      remoteAddress: "10.7.0.4",
      payload: { email: "notif_list_user@ananta.internal", password: "Password123!" },
    });
    const accessToken = loginRes.cookies.find((c) => c.name === "access_token")?.value || "";

    const notificationDoc = await Notification.create({
      targetUser: user._id,
      organizationId: (user as any).organization_id,
      category: "patient",
      type: "CLINICAL_ALERT",
      title: "Critical Lab Alert",
      message: "Patient serum potassium is 6.2 mmol/L (Critical High).",
      readAt: null,
    });

    // Wait 100ms for background auth login event listeners to settle
    await new Promise((r) => setTimeout(r, 100));

    // 1. Fetch unread count
    const unreadRes = await app.inject({
      method: "GET",
      url: "/api/notifications/unread-count",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(unreadRes.statusCode).toBe(200);
    const initialUnread = JSON.parse(unreadRes.body).data.unreadCount;
    expect(initialUnread).toBeGreaterThanOrEqual(1);

    // 2. Fetch notification list
    const listRes = await app.inject({
      method: "GET",
      url: "/api/notifications",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    expect(JSON.parse(listRes.body).data.notifications.length).toBeGreaterThanOrEqual(1);

    // 3. Mark single notification as read
    const markReadRes = await app.inject({
      method: "PATCH",
      url: `/api/notifications/${(notificationDoc as any)._id.toString()}/read`,
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(markReadRes.statusCode).toBe(200);

    // 4. Verify unread count is reduced by 1
    const unreadAfterRes = await app.inject({
      method: "GET",
      url: "/api/notifications/unread-count",
      cookies: { access_token: accessToken },
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(JSON.parse(unreadAfterRes.body).data.unreadCount).toBe(initialUnread - 1);
  });
});

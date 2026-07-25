import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { notificationService } from "../notifications/services/NotificationService.ts";
import { notificationStreamHandler } from "../notifications/websocket.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { User } from "../models/User.ts";
import { emailProvider } from "../notifications/providers/emailProvider.ts";

export default async function notificationRoutes(app: FastifyInstance) {

  // ─── Realtime SSE Stream ─────────────────────────────────────────
  app.get("/api/notifications/stream", { preHandler: [authenticate] }, notificationStreamHandler);

  // ─── Operational Metrics Monitoring ──────────────────────────────
  app.get("/api/notifications/metrics", { preHandler: [authenticate] }, async (req, reply) => {
    const metrics = await notificationService.getMetrics();
    return reply.send({
      success: true,
      data: metrics,
    });
  });

  // ─── Unread Count ─────────────────────────────────────────────────
  app.get("/api/notifications/unread-count", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const unreadCount = await notificationService.getUnreadCount(userId, organizationId);
    return reply.send({
      success: true,
      data: { unreadCount },
    });
  });

  // ─── List Notifications ───────────────────────────────────────────
  app.get("/api/notifications", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const { page, limit, category, unreadOnly, archived, search, entityType, entityId, includeSnoozed } = req.query as any;

    const result = await notificationService.getNotifications(userId, {
      organizationId,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
      category,
      unreadOnly: unreadOnly === "true",
      archived: archived === "true",
      search,
      entityType,
      entityId,
      includeSnoozed: includeSnoozed === "true",
    });

    return reply.send({
      success: true,
      data: result,
    });
  });

  // ─── Mark Single Read ─────────────────────────────────────────────
  app.patch("/api/notifications/:id/read", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    if (!id || id.length !== 24) {
      return reply.code(400).send({ success: false, message: "Invalid notification ID format" });
    }

    const result = await notificationService.markAsRead(userId, id, organizationId);
    return reply.send({
      success: true,
      message: "Notification marked as read",
      data: result,
    });
  });

  // ─── Mark All Read ────────────────────────────────────────────────
  app.patch("/api/notifications/read-all", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const result = await notificationService.markAllAsRead(userId, organizationId);
    return reply.send({
      success: true,
      message: "All notifications marked as read",
      data: result,
    });
  });

  // ─── Archive Notification ─────────────────────────────────────────
  app.patch("/api/notifications/:id/archive", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    if (!id || id.length !== 24) {
      return reply.code(400).send({ success: false, message: "Invalid notification ID format" });
    }

    const result = await notificationService.archiveNotification(userId, id, organizationId);
    return reply.send({
      success: true,
      message: "Notification archived",
      data: result,
    });
  });

  // ─── Delete Notification ──────────────────────────────────────────
  app.delete("/api/notifications/:id", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    if (!id || id.length !== 24) {
      return reply.code(400).send({ success: false, message: "Invalid notification ID format" });
    }

    const result = await notificationService.deleteNotification(userId, id, organizationId);
    return reply.send({
      success: true,
      message: "Notification deleted",
      data: result,
    });
  });

  // ─── Snooze Notification ──────────────────────────────────────────
  app.patch("/api/notifications/:id/snooze", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const { id } = req.params as { id: string };
    const { durationMinutes } = (req.body as any) || {};

    if (!id || id.length !== 24) {
      return reply.code(400).send({ success: false, message: "Invalid notification ID format" });
    }

    const minutes = Number(durationMinutes) || 60;
    const result = await notificationService.snoozeNotification(userId, id, minutes, organizationId);
    return reply.send({
      success: true,
      message: `Notification snoozed for ${minutes} minutes`,
      data: result,
    });
  });

  // ─── Pin / Unpin Notification ─────────────────────────────────────
  app.patch("/api/notifications/:id/pin", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const { id } = req.params as { id: string };

    if (!id || id.length !== 24) {
      return reply.code(400).send({ success: false, message: "Invalid notification ID format" });
    }

    const result = await notificationService.togglePinNotification(userId, id, organizationId);
    return reply.send({
      success: true,
      message: "Notification pin status updated",
      data: result,
    });
  });

  // ─── Fetch Organization Users for Recipient Selection ────────────
  app.get("/api/notifications/users", { preHandler: [authenticate] }, async (req, reply) => {
    const organizationId = req.user!.organization_id;
    let users = await User.find(organizationId ? { organization_id: organizationId } : {}).select("_id name email role").lean();
    if (users.length === 0) {
      users = await User.find({}).select("_id name email role").limit(100).lean();
    }
    return reply.send({
      success: true,
      data: users.map((u: any) => ({
        id: u._id.toString(),
        name: u.name || u.email,
        email: u.email,
        role: u.role || "user",
      })),
    });
  });

  // ─── Send / Broadcast In-App Notification ────────────────────────
  app.post("/api/notifications/send", { preHandler: [authenticate] }, async (req, reply) => {
    const senderUserId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const {
      recipientScope = "all",
      targetUserId,
      category = "system",
      title,
      message,
      severity = "info",
      priority = "medium",
      actionUrl,
      channels = { inApp: true, email: true },
    } = (req.body as any) || {};

    if (!title || !message) {
      return reply.code(400).send({ success: false, message: "Title and message are required" });
    }

    let targetUsers: string[] = [];

    if (recipientScope === "user" && targetUserId) {
      targetUsers = [targetUserId];
    } else {
      const userFilter: any = {};
      if (recipientScope !== "all") {
        userFilter.role = recipientScope;
      }
      let users = await User.find(userFilter).select("_id").lean();
      targetUsers = users.map((u: any) => u._id.toString());
    }

    if (targetUsers.length === 0) {
      // Fallback to sender
      targetUsers = [senderUserId];
    }

    let dispatchedCount = 0;
    for (const recipientId of targetUsers) {
      eventBus.publish({
        eventId: `manual_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        eventType: EVENT_TYPES.SYSTEM_ALERT,
        category,
        targetUserId: recipientId,
        createdBy: senderUserId,
        title,
        message,
        severity,
        priority,
        actionUrl: actionUrl || undefined,
        organizationId,
        metadata: {
          requestedChannels: channels,
        },
      });
      dispatchedCount++;
    }

    const channelNames = Object.entries(channels)
      .filter(([_k, v]) => v)
      .map(([k]) => k)
      .join(", ");

    return reply.send({
      success: true,
      message: `Successfully dispatched notification to ${dispatchedCount} user(s) via [${channelNames || "inApp"}]`,
      data: { count: dispatchedCount, channels },
    });
  });

  // ─── Test Trigger Endpoint (Infrastructure Validation) ───────────
  app.post("/api/notifications/test-trigger", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;
    const { category, title, message, severity } = (req.body as any) || {};

    const validCategories = ["auth", "organization", "team", "task", "patient", "billing", "security", "system"];
    const validSeverities = ["info", "success", "warning", "error"];

    const selectedCategory = validCategories.includes(category) ? category : "system";
    const selectedSeverity = validSeverities.includes(severity) ? severity : "info";

    eventBus.publish({
      eventId: `test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
      eventType: EVENT_TYPES.SYSTEM_ALERT,
      category: selectedCategory,
      targetUserId: userId,
      title: title || "Infrastructure Test Notification",
      message: message || "This is a real-time test event emitted via the decoupled event bus.",
      severity: selectedSeverity,
      actionUrl: "/dashboard/notifications",
      icon: "bell",
      organizationId,
    });

    return reply.send({
      success: true,
      message: "Test event dispatched successfully",
    });
  });

  // ─── Test Direct Email Dispatch Endpoint ─────────────────────────
  app.post("/api/notifications/test-email", { preHandler: [authenticate] }, async (req, reply) => {
    const userEmail = req.user?.email;
    const { targetEmail } = (req.body as any) || {};
    const recipient = targetEmail || userEmail;

    if (!recipient) {
      return reply.code(400).send({ success: false, message: "No recipient email address available" });
    }

    const sent = await emailProvider.sendEmail({
      to: recipient,
      subject: "Test Email from Ananta Health Platform",
      text: `Hello,\n\nThis is a test email sent from your Ananta Health application.\nIf you received this, your outbound email configuration is working properly!\n\nBest regards,\nAnanta Health System`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #2563eb; margin-top: 0;">Ananta Health - Email Delivery Test</h2>
          <p>Hello,</p>
          <p>This is a test email sent from your <strong>Ananta Health</strong> system to verify your email delivery configuration.</p>
          <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #2563eb; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #475569;">
              <strong>Recipient:</strong> ${recipient}<br/>
              <strong>Timestamp:</strong> ${new Date().toLocaleString()}
            </p>
          </div>
          <p>If you see this in your inbox, your email provider settings are correctly configured!</p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">Ananta Health System &bull; Automated Delivery</p>
        </div>
      `,
    });

    if (sent) {
      return reply.send({
        success: true,
        message: `Test email dispatched to ${recipient}`,
      });
    } else {
      return reply.code(500).send({
        success: false,
        message: "Failed to send test email. Please check server logs and backend/.env SMTP credentials.",
      });
    }
  });
}


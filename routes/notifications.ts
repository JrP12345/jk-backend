import type { FastifyInstance } from "fastify";
import { authenticate, checkPermission } from "../middleware/auth.ts";
import { notificationService } from "../notifications/services/NotificationService.ts";
import { notificationStreamHandler, handleNotificationWebSocket } from "../notifications/websocket.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { User } from "../models/User.ts";
import { Organization } from "../models/Organization.ts";
import { emailProvider, type SmtpConfig } from "../notifications/providers/emailProvider.ts";
import { decrypt } from "../utilities/encryption.ts";
import { OrgMember } from "../models/OrgMember.ts";
import { resolveTargetOrganizationId } from "../utilities/tenant.ts";

async function getOrganizationSmtp(organizationId?: string | null): Promise<SmtpConfig | null> {
  if (!organizationId) return null;
  const organization = await Organization.findById(organizationId).select("smtp").lean();
  const smtp = (organization as any)?.smtp;
  if (!smtp?.host || !smtp?.user || !smtp?.pass) return null;

  return {
    host: smtp.host,
    port: smtp.port || 587,
    secure: smtp.secure || false,
    user: smtp.user,
    pass: decrypt(smtp.pass),
    fromEmail: smtp.fromEmail || smtp.user,
    fromName: smtp.fromName || "Anant Health",
  };
}

export default async function notificationRoutes(app: FastifyInstance) {
  const adminNotifications = { preHandler: [authenticate, checkPermission("MANAGE_ORGANIZATION")] };

  // ─── Native WebSockets (Bidirectional Realtime Stream) ───────────
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    handleNotificationWebSocket(socket as any, req);
  });
  app.get("/api/notifications/ws", { websocket: true }, (socket, req) => {
    handleNotificationWebSocket(socket as any, req);
  });

  // ─── Realtime SSE Stream (Fallback) ──────────────────────────────
  app.get("/api/notifications/stream", { preHandler: [authenticate] }, notificationStreamHandler);

  // ─── Operational Metrics Monitoring ──────────────────────────────
  app.get("/api/notifications/metrics", adminNotifications, async (req, reply) => {
    const metrics = await notificationService.getMetrics();
    return reply.send({
      success: true,
      data: metrics,
    });
  });

  // ─── SMS/WhatsApp Dispatch Logs ──────────────────────────────────
  app.get("/api/notifications/dispatch-logs", adminNotifications, async (req, reply) => {
    const { NotificationLog } = await import("../models/NotificationLog.ts");
    const organizationId = await resolveTargetOrganizationId(req);
    if (!organizationId) return reply.code(403).send({ success: false, message: "Organization context is required" });
    const logs = await NotificationLog.find({ organizationId }).sort({ createdAt: -1 }).limit(50);
    return reply.send({
      success: true,
      data: logs,
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
  app.get("/api/notifications/users", adminNotifications, async (req, reply) => {
    const organizationId = await resolveTargetOrganizationId(req);
    if (!organizationId) return reply.code(403).send({ success: false, message: "Organization context is required" });
    const members = await OrgMember.find({ organizationId }).select("userId role").lean();
    const userIds = members.map((member) => member.userId);
    const users = await User.find({ _id: { $in: userIds }, isActive: true }).select("_id name email role").lean();
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
  app.post("/api/notifications/send", adminNotifications, async (req, reply) => {
    const senderUserId = req.user!.id;
    const organizationId = await resolveTargetOrganizationId(req);
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
    if (!organizationId) {
      return reply.code(403).send({ success: false, message: "Organization context is required" });
    }

    let targetUsers: any[] = [];

    if (recipientScope === "user" && targetUserId) {
      const member = await OrgMember.findOne({ organizationId, userId: targetUserId }).select("userId").lean();
      if (!member) return reply.code(404).send({ success: false, message: "Recipient is not a member of this organization" });
      targetUsers = await User.find({ _id: member.userId, isActive: true }).select("_id email name").lean();
    } else {
      const memberFilter: any = { organizationId };
      if (recipientScope !== "all") memberFilter.role = recipientScope;
      const members = await OrgMember.find(memberFilter).select("userId").lean();
      targetUsers = await User.find({ _id: { $in: members.map((member) => member.userId) }, isActive: true }).select("_id email name").lean();
    }

    if (targetUsers.length === 0) {
      return reply.code(404).send({ success: false, message: "No active recipients found in this organization" });
    }

    const orgSmtp = channels?.email ? await getOrganizationSmtp(organizationId) : null;
    let dispatchedCount = 0;
    const emailsSentTo: string[] = [];
    const emailFailures: string[] = [];
    for (const targetUser of targetUsers) {
      const recipientId = targetUser._id.toString();

      // 1. Dispatch In-App notification event
      if (channels?.inApp !== false) {
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
      }

      // 2. Dispatch Email alert if email channel enabled and user has valid email
      if (channels?.email && targetUser.email) {
        const sent = await emailProvider.sendEmail({
          to: targetUser.email,
          subject: `[${severity.toUpperCase()}] ${title}`,
          text: message,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
              <div style="display: flex; items-center; justify-content: space-between; border-bottom: 2px solid #3b82f6; padding-bottom: 12px; margin-bottom: 20px;">
                <h2 style="color: #1e293b; margin: 0; font-size: 20px;">Anant Health Alert</h2>
                <span style="background-color: #3b82f6; color: #ffffff; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: bold; text-transform: uppercase;">${category}</span>
              </div>
              <h3 style="color: #0f172a; margin-top: 0; font-size: 16px;">${title}</h3>
              <div style="background-color: #f8fafc; padding: 16px; border-left: 4px solid #3b82f6; border-radius: 6px; margin: 16px 0;">
                <p style="margin: 0; font-size: 14px; color: #334155; line-height: 1.6;">${message.replace(/\n/g, "<br/>")}</p>
              </div>
              ${actionUrl ? `<div style="margin: 24px 0;"><a href="${actionUrl}" style="background-color: #2563eb; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 13px; display: inline-block;">View Action Destination &rarr;</a></div>` : ""}
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0 16px 0;" />
              <p style="font-size: 11px; color: #94a3b8; text-align: center; margin: 0;">Sent by Anant Health Intelligence System &bull; Confidential Medical Telemetry</p>
            </div>
          `,
        }, orgSmtp);
        if (sent) emailsSentTo.push(targetUser.email);
        else emailFailures.push(targetUser.email);
      }

      dispatchedCount++;
    }

    const channelNames = Object.entries(channels)
      .filter(([_k, v]) => v)
      .map(([k]) => k)
      .join(", ");

    const sentEmails = emailsSentTo;

    return reply.send({
      success: true,
      message: `Dispatched to ${dispatchedCount} user(s) via [${channelNames || "inApp"}]${
        channels?.email ? ` — Email sent to: ${sentEmails.join(", ")}` : ""
      }`,
      data: { count: dispatchedCount, channels, emailsSentTo, emailFailures },
    });
  });

  // ─── Test Trigger Endpoint (Infrastructure Validation) ───────────
  app.post("/api/notifications/test-trigger", adminNotifications, async (req, reply) => {
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
  app.post("/api/notifications/test-email", adminNotifications, async (req, reply) => {
    const userEmail = req.user?.email;
    const orgId = req.user?.organization_id;
    const { targetEmail } = (req.body as any) || {};
    const recipient = targetEmail || userEmail;

    if (!recipient) {
      return reply.code(400).send({ success: false, message: "No recipient email address available" });
    }
    if (orgId) {
      const recipientUser = await User.findOne({ email: recipient, isActive: true }).select("_id").lean();
      const member = recipientUser ? await OrgMember.exists({ organizationId: orgId, userId: recipientUser._id }) : null;
      if (!member) return reply.code(404).send({ success: false, message: "Recipient is not an active organization member" });
    }

    // Load org SMTP config if available — decrypt password before use
    let orgSmtp: SmtpConfig | null = null;
    if (orgId) {
      const org = await Organization.findById(orgId).select("smtp").lean();
      const smtp = (org as any)?.smtp;
      if (smtp?.host && smtp?.user && smtp?.pass) {
        orgSmtp = {
          host: smtp.host,
          port: smtp.port || 587,
          secure: smtp.secure || false,
          user: smtp.user,
          pass: decrypt(smtp.pass),   // ← AES-256-GCM decrypt before SMTP auth
          fromEmail: smtp.fromEmail || smtp.user,
          fromName: smtp.fromName || "Anant Health",
        };
      }
    }

    const sent = await emailProvider.sendEmail({
      to: recipient,
      subject: "Test Email from Anant Health Platform",
      text: `Hello,\n\nThis is a test email sent from your Anant Health application.\nIf you received this, your outbound email configuration is working properly!\n\nBest regards,\nAnant Health System`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h2 style="color: #2563eb; margin-top: 0;">Anant Health - Email Delivery Test</h2>
          <p>Hello,</p>
          <p>This is a test email sent from your <strong>Anant Health</strong> system to verify your email delivery configuration.</p>
          <div style="background-color: #f8fafc; padding: 15px; border-left: 4px solid #2563eb; border-radius: 4px; margin: 20px 0;">
            <p style="margin: 0; font-size: 14px; color: #475569;">
              <strong>Recipient:</strong> ${recipient}<br/>
              <strong>Source:</strong> ${orgSmtp ? "Organization SMTP Gateway" : "Environment (.env) SMTP"}<br/>
              <strong>Timestamp:</strong> ${new Date().toLocaleString()}
            </p>
          </div>
          <p>If you see this in your inbox, your email provider settings are correctly configured!</p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">Anant Health System &bull; Automated Delivery</p>
        </div>
      `,
    }, orgSmtp);

    if (sent) {
      return reply.send({
        success: true,
        message: `Test email dispatched to ${recipient}${orgSmtp ? " via organization SMTP gateway" : ""}`,
      });
    } else {
      return reply.code(500).send({
        success: false,
        message: "Failed to send test email. Check SMTP configuration in Organization Settings or backend/.env.",
      });
    }
  });
}

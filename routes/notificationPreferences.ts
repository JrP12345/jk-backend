import type { FastifyInstance } from "fastify";
import { authenticate } from "../middleware/auth.ts";
import { notificationService } from "../notifications/services/NotificationService.ts";

export default async function notificationPreferenceRoutes(app: FastifyInstance) {
  // ─── Get Preferences ────────────────────────────────────────────────
  app.get("/api/notification-preferences", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const organizationId = req.user!.organization_id;

    const preferences = await notificationService.getPreferences(userId, organizationId);
    return reply.send({
      success: true,
      data: preferences,
    });
  });

  // ─── Update Preferences ─────────────────────────────────────────────
  app.patch("/api/notification-preferences", { preHandler: [authenticate] }, async (req, reply) => {
    const userId = req.user!.id;
    const { channels, categories } = req.body as any;

    const updated = await notificationService.updatePreferences(userId, { channels, categories });
    return reply.send({
      success: true,
      message: "Notification preferences updated successfully",
      data: updated,
    });
  });
}

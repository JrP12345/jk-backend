import mongoose from "mongoose";
import { Notification, type INotification } from "../../models/Notification.ts";
import { NotificationPreference } from "../../models/NotificationPreference.ts";
import { NotificationDelivery } from "../../models/NotificationDelivery.ts";
import { User } from "../../models/User.ts";
import { emailProvider } from "../providers/emailProvider.ts";
import { broadcastRealtimeNotification, getActiveSseConnectionsCount } from "../websocket.ts";
import { notificationQueue } from "./NotificationQueue.ts";
import { notificationRuleEngine } from "./NotificationRuleEngine.ts";
import type { DomainEventPayload } from "../../events/types.ts";
import { eventBus } from "../../events/eventBus.ts";

export class NotificationService {
  constructor() {
    // Automatically subscribe to the central Event Bus
    eventBus.subscribeAll((event) => {
      this.handleDomainEvent(event).catch((err) => {
        console.error(`[NotificationService Error] Failed handling event ${event.eventType}:`, err);
      });
    });
  }

  /**
   * Operational metrics helper for monitoring queue depth and SSE connections
   */
  public async getMetrics() {
    const queueDepth = await notificationQueue.getQueueDepth();
    const stats = notificationQueue.getStats();
    const activeSseConnections = getActiveSseConnectionsCount();

    return {
      queueDepth,
      activeSseConnections,
      queueStats: stats,
    };
  }

  /**
   * Get or initialize default user notification preferences
   */
  public async getPreferences(userId: string, organizationId?: string) {
    let pref = await NotificationPreference.findOne({ userId: new mongoose.Types.ObjectId(userId) }).lean();
    if (!pref) {
      try {
        pref = (
          await NotificationPreference.create({
            userId: new mongoose.Types.ObjectId(userId),
            organizationId: organizationId ? new mongoose.Types.ObjectId(organizationId) : undefined,
          })
        ).toJSON() as any;
      } catch (err: any) {
        if (err.code === 11000) {
          pref = await NotificationPreference.findOne({ userId: new mongoose.Types.ObjectId(userId) }).lean();
        } else {
          throw err;
        }
      }
    }
    return pref;
  }

  /**
   * Update notification preferences
   */
  public async updatePreferences(userId: string, data: { channels?: any; categories?: any }) {
    const pref = await NotificationPreference.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      {
        $set: {
          ...(data.channels ? { channels: data.channels } : {}),
          ...(data.categories ? { categories: data.categories } : {}),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after", upsert: true }
    );
    return pref;
  }

  /**
   * Main domain event handler triggered by EventBus
   */
  public async handleDomainEvent(event: DomainEventPayload) {
    const {
      eventId,
      targetUserId,
      category,
      type,
      title,
      message,
      priority,
      severity,
      actionUrl,
      icon,
      metadata,
      organizationId,
      createdBy,
    } = event;

    if (!targetUserId) return;

    // Idempotency Check Guard
    const idempotencyKey = eventId || metadata?.idempotencyKey;
    if (idempotencyKey) {
      const existing = await Notification.findOne({
        targetUser: new mongoose.Types.ObjectId(targetUserId),
        idempotencyKey,
      });
      if (existing) {
        console.log(`[NotificationService] Suppressed duplicate event ${type} (Idempotency Key: ${idempotencyKey})`);
        return;
      }
    }

    // 1. Fetch user preferences
    const pref = await this.getPreferences(targetUserId, organizationId);
    if (!pref) return;

    const mappedCategory = (category === "clinical" ? "patient" : category) as any;

    // Check category preferences
    if (pref.categories && (pref.categories as any)[mappedCategory] === false) {
      console.log(`[NotificationService] Suppressed event ${type} for user ${targetUserId} (Category ${category} disabled)`);
      return;
    }

    // Evaluate Level 4 Rule & Escalation Engine routing
    const effectiveChannels = notificationRuleEngine.evaluateRouting(event, pref.channels);

    let createdNotification: any = null;

    // 2. In-App channel delivery & DB persistence (Synchronous for Zero-Latency Inbox)
    if (effectiveChannels.inApp) {
      createdNotification = await Notification.create({
        organizationId: organizationId ? new mongoose.Types.ObjectId(organizationId) : undefined,
        createdBy: createdBy ? new mongoose.Types.ObjectId(createdBy) : undefined,
        targetUser: new mongoose.Types.ObjectId(targetUserId),
        category: mappedCategory,
        type: type || event.eventType || "NOTIFICATION",
        title,
        message,
        priority: priority || "medium",
        severity: severity || "info",
        actionUrl,
        icon,
        metadata,
        idempotencyKey,
        entityType: event.metadata?.entityType,
        entityId: event.metadata?.entityId,
        groupKey: event.metadata?.groupKey,
        createdAt: new Date(),
      });

      // Record in-app delivery log
      await NotificationDelivery.create({
        notificationId: createdNotification._id,
        channel: "inApp",
        recipient: targetUserId,
        status: "delivered",
        sentAt: new Date(),
      });

      // Fetch new unread count
      const unreadCount = await this.getUnreadCount(targetUserId, organizationId);

      // Broadcast instant real-time notification
      broadcastRealtimeNotification(targetUserId, {
        type: "NOTIFICATION_RECEIVED",
        data: {
          notification: createdNotification.toJSON(),
          unreadCount,
        },
      });
    }

    // 3. External Channel Deliveries (Email Background Job Enqueue)
    const requested = event.metadata?.requestedChannels;
    const shouldSendEmail = (requested?.email !== false && effectiveChannels.email) || requested?.email === true;

    if (shouldSendEmail && createdNotification) {
      let recipientEmail: string | undefined;
      try {
        const userDoc: any = await User.findById(targetUserId).select("email").lean();
        if (userDoc?.email) {
          recipientEmail = userDoc.email;
        }
      } catch (err) {
        console.warn(`[NotificationService Warning] Could not resolve email for user ${targetUserId}`, err);
      }

      if (recipientEmail?.trim()) {
        await notificationQueue.enqueue({
          notificationId: createdNotification._id.toString(),
          channel: "email",
          recipient: recipientEmail,
          title: title || "Notification Alert",
          message: message || "",
        });
      }
    }
  }

  /**
   * Fetch user notifications with filters, multi-tenant isolation, pinned sorting, and pagination
   */
  public async getNotifications(
    userId: string,
    query: {
      organizationId?: string;
      page?: number;
      limit?: number;
      category?: string;
      unreadOnly?: boolean;
      archived?: boolean;
      search?: string;
      entityType?: string;
      entityId?: string;
      includeSnoozed?: boolean;
    }
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter: any = {
      targetUser: new mongoose.Types.ObjectId(userId),
      archived: query.archived === true,
      deletedAt: null,
    };

    if (!query.includeSnoozed) {
      filter.$or = [
        { snoozedUntil: null },
        { snoozedUntil: { $lte: new Date() } },
      ];
    }

    if (query.organizationId) {
      filter.organizationId = new mongoose.Types.ObjectId(query.organizationId);
    }

    if (query.category) {
      filter.category = query.category;
    }

    if (query.entityType) {
      filter.entityType = query.entityType;
    }

    if (query.entityId) {
      filter.entityId = query.entityId;
    }

    if (query.unreadOnly) {
      filter.readAt = null;
    }

    if (query.search) {
      const searchRegex = { $regex: query.search, $options: "i" };
      if (filter.$or) {
        filter.$and = [
          { $or: filter.$or },
          { $or: [{ title: searchRegex }, { message: searchRegex }] },
        ];
        delete filter.$or;
      } else {
        filter.$or = [{ title: searchRegex }, { message: searchRegex }];
      }
    }

    const [items, total] = await Promise.all([
      Notification.find(filter).sort({ pinned: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments(filter),
    ]);

    const unreadCount = await this.getUnreadCount(userId, query.organizationId);

    return {
      notifications: items.map((doc: any) => ({
        ...doc,
        id: doc._id.toString(),
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      unreadCount,
    };
  }

  /**
   * Fast unread count getter with multi-tenant isolation and snooze exclusion
   */
  public async getUnreadCount(userId: string, organizationId?: string): Promise<number> {
    const filter: any = {
      targetUser: new mongoose.Types.ObjectId(userId),
      readAt: null,
      archived: false,
      deletedAt: null,
      $or: [
        { snoozedUntil: null },
        { snoozedUntil: { $lte: new Date() } },
      ],
    };

    if (organizationId) {
      const orgIdObj = new mongoose.Types.ObjectId(organizationId);
      filter.$and = [
        { $or: filter.$or },
        { $or: [{ organizationId: orgIdObj }, { organizationId: null }, { organizationId: { $exists: false } }] },
      ];
      delete filter.$or;
    }

    return Notification.countDocuments(filter);
  }

  /**
   * Mark single notification as read with multi-tenant scoping
   */
  public async markAsRead(userId: string, notificationId: string, organizationId?: string) {
    const filter: any = {
      _id: new mongoose.Types.ObjectId(notificationId),
      targetUser: new mongoose.Types.ObjectId(userId),
      deletedAt: null,
    };

    if (organizationId) {
      const orgIdObj = new mongoose.Types.ObjectId(organizationId);
      filter.$or = [
        { organizationId: orgIdObj },
        { organizationId: null },
        { organizationId: { $exists: false } },
      ];
    }

    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { readAt: new Date() } },
      { returnDocument: "after" }
    );

    const unreadCount = await this.getUnreadCount(userId, organizationId);
    broadcastRealtimeNotification(userId, {
      type: "UNREAD_COUNT_UPDATED",
      data: { unreadCount },
    });

    return { notification, unreadCount };
  }

  /**
   * Mark all unread notifications as read with multi-tenant scoping
   */
  public async markAllAsRead(userId: string, organizationId?: string) {
    const filter: any = {
      targetUser: new mongoose.Types.ObjectId(userId),
      readAt: null,
      archived: false,
      deletedAt: null,
    };

    if (organizationId) {
      filter.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    await Notification.updateMany(filter, { $set: { readAt: new Date() } });

    const unreadCount = await this.getUnreadCount(userId, organizationId);

    broadcastRealtimeNotification(userId, {
      type: "UNREAD_COUNT_UPDATED",
      data: { unreadCount },
    });

    return { unreadCount };
  }

  /**
   * Archive a notification with multi-tenant scoping
   */
  public async archiveNotification(userId: string, notificationId: string, organizationId?: string) {
    const filter: any = {
      _id: new mongoose.Types.ObjectId(notificationId),
      targetUser: new mongoose.Types.ObjectId(userId),
      deletedAt: null,
    };

    if (organizationId) {
      filter.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { archived: true } },
      { returnDocument: "after" }
    );

    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { notification, unreadCount };
  }

  /**
   * Soft delete a notification with multi-tenant scoping
   */
  public async deleteNotification(userId: string, notificationId: string, organizationId?: string) {
    const filter: any = {
      _id: new mongoose.Types.ObjectId(notificationId),
      targetUser: new mongoose.Types.ObjectId(userId),
      deletedAt: null,
    };

    if (organizationId) {
      filter.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    await Notification.findOneAndUpdate(filter, { $set: { deletedAt: new Date() } });

    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { unreadCount };
  }

  /**
   * Snooze a notification for a specified duration in minutes
   */
  public async snoozeNotification(userId: string, notificationId: string, durationMinutes: number, organizationId?: string) {
    const filter: any = {
      _id: new mongoose.Types.ObjectId(notificationId),
      targetUser: new mongoose.Types.ObjectId(userId),
      deletedAt: null,
    };

    if (organizationId) {
      filter.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    const snoozedUntil = new Date(Date.now() + durationMinutes * 60 * 1000);

    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { snoozedUntil } },
      { returnDocument: "after" }
    );

    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { notification, unreadCount };
  }

  /**
   * Toggle pin status of a notification
   */
  public async togglePinNotification(userId: string, notificationId: string, organizationId?: string) {
    const filter: any = {
      _id: new mongoose.Types.ObjectId(notificationId),
      targetUser: new mongoose.Types.ObjectId(userId),
      deletedAt: null,
    };

    if (organizationId) {
      filter.organizationId = new mongoose.Types.ObjectId(organizationId);
    }

    const currentDoc = await Notification.findOne(filter);
    if (!currentDoc) return null;

    const notification = await Notification.findOneAndUpdate(
      filter,
      { $set: { pinned: !currentDoc.pinned } },
      { returnDocument: "after" }
    );

    const unreadCount = await this.getUnreadCount(userId, organizationId);
    return { notification, unreadCount };
  }
}

export const notificationService = new NotificationService();

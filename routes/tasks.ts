import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { authenticate, checkAnyPermission } from "../middleware/auth.ts";
import { TaskModel } from "../models/Task.ts";
import { eventBus } from "../events/eventBus.ts";
import { EVENT_TYPES } from "../events/types.ts";
import { successResponse, errorResponse } from "../utilities/helpers.ts";
import { createTaskSchema, updateTaskStatusSchema } from "../schemas/operations.ts";

export default async function taskRoutes(app: FastifyInstance) {
  const createTaskAccess = { preHandler: [authenticate, checkAnyPermission("MANAGE_ORGANIZATION", "MANAGE_STAFF", "MANAGE_APPOINTMENTS")] };
  const authenticated = { preHandler: [authenticate] };

  // ─── Create Task ─────────────────────────────────────────────────
  app.post("/api/tasks", { ...createTaskAccess, schema: createTaskSchema }, async (req, reply) => {
    try {
      const createdBy = req.user!.id;
      const organizationId = req.user?.organization_id;
      const { title, description, assignedTo, priority, dueDate } = req.body as any;

      if (!title || !assignedTo) {
        return reply.code(400).send(errorResponse("title and assignedTo are required"));
      }
      if (!mongoose.Types.ObjectId.isValid(assignedTo)) {
        return reply.code(400).send(errorResponse("Invalid assignedTo user ID"));
      }

      const task = await TaskModel.create({
        organizationId: organizationId ? new mongoose.Types.ObjectId(organizationId) : undefined,
        title,
        description: description || null,
        assignedTo: new mongoose.Types.ObjectId(assignedTo),
        createdBy: new mongoose.Types.ObjectId(createdBy),
        priority: priority || "medium",
        dueDate: dueDate ? new Date(dueDate) : undefined,
      });

      // Emit TASK_ASSIGNED domain event
      await eventBus.publishDurable({
        eventType: EVENT_TYPES.TASK_ASSIGNED,
        category: "task",
        targetUserId: assignedTo,
        createdBy,
        title: `Task Assigned: ${title}`,
        message: description || `You have been assigned a new task: "${title}".`,
        priority: priority || "medium",
        severity: "info",
        actionUrl: "/dashboard",
        organizationId,
      });

      return reply.code(201).send(successResponse(task, "Task created and assigned successfully"));
    } catch (err) {
      console.error("createTask error:", err);
      return reply.code(500).send(errorResponse("Internal server error"));
    }
  });

  // ─── List User Tasks ──────────────────────────────────────────────
  app.get("/api/tasks", authenticated, async (req, reply) => {
    try {
      const userId = req.user!.id;
      const tasks = await TaskModel.find({ assignedTo: new mongoose.Types.ObjectId(userId) })
        .sort({ createdAt: -1 })
        .lean();

      return reply.code(200).send(successResponse(tasks));
    } catch (err) {
      console.error("getTasks error:", err);
      return reply.code(500).send(errorResponse("Internal server error"));
    }
  });

  // ─── Update Task Status ───────────────────────────────────────────
  app.patch("/api/tasks/:id/status", { ...authenticated, schema: updateTaskStatusSchema }, async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: string };
      const allowedStatuses = new Set(["todo", "in_progress", "review", "completed"]);

      if (!mongoose.Types.ObjectId.isValid(id)) {
        return reply.code(400).send(errorResponse("Invalid task ID"));
      }
      if (!allowedStatuses.has(status)) {
        return reply.code(400).send(errorResponse("Invalid task status"));
      }

      const task = await TaskModel.findById(id);
      if (!task) {
        return reply.code(404).send(errorResponse("Task not found"));
      }
      const userId = req.user!.id;
      const organizationId = req.user?.organization_id;
      const isAssignee = task.assignedTo.toString() === userId;
      const isCreator = task.createdBy.toString() === userId;
      const sameOrganization = !task.organizationId || !organizationId || task.organizationId.toString() === organizationId;
      if (!sameOrganization || (!isAssignee && !isCreator)) {
        return reply.code(404).send(errorResponse("Task not found"));
      }

      task.status = status as any;
      task.updatedAt = new Date();
      await task.save();

      // Emit TASK_STATUS_CHANGED event to creator if updated by assignee
      if (task.createdBy.toString() !== req.user!.id) {
        await eventBus.publishDurable({
          eventType: EVENT_TYPES.TASK_STATUS_CHANGED,
          category: "task",
          targetUserId: task.createdBy.toString(),
          title: `Task Status Updated`,
          message: `Task "${task.title}" status changed to ${status}.`,
          severity: "info",
          actionUrl: "/dashboard",
        });
      }

      return reply.code(200).send(successResponse(task, "Task status updated successfully"));
    } catch (err) {
      console.error("updateTaskStatus error:", err);
      return reply.code(500).send(errorResponse("Internal server error"));
    }
  });
}
